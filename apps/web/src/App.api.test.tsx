import { StrictMode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { WebClient } from './client/webClient';
import { captureEmailLink, createRuntime } from './client/runtime';
import {
  accepted,
  csrf,
  error,
  history,
  item,
  json,
  login,
  page,
  product,
  token,
  unavailableProduct,
  user,
} from './client/testFixtures';

type Handler = (
  path: string,
  init: RequestInit,
) => Response | Promise<Response> | undefined;
function open(
  path: string,
  handler: Handler = () => undefined,
  currentUser: typeof user | null = user,
  strict = false,
) {
  window.history.replaceState(null, '', path);
  const emailLink = captureEmailLink();
  const unexpected: string[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url, init = {}) => {
      const path = String(url);
      const response = handler(path, init);
      if (response) return response;
      if (path === '/api/auth/web/me')
        return currentUser
          ? json(currentUser)
          : json(error('AUTH_REQUIRED'), 401);
      if (path === '/api/auth/web/csrf') return json(csrf());
      unexpected.push(`${init.method} ${path}`);
      return json(error('INTERNAL_ERROR'), 500);
    });
  const client = new WebClient({ fetch });
  const app = <App runtime={{ mode: 'api', client }} emailLink={emailLink} />;
  const result = render(strict ? <StrictMode>{app}</StrictMode> : app);
  return { ...result, client, fetch, unexpected };
}
const change = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name, { exact: true }), {
    target: { value },
  });
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('explicit sample/API selection', () => {
  it('defaults to a fresh sample boundary with no session restore, storage, or real credential fields', async () => {
    vi.stubEnv('VITE_DATA_SOURCE', undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    window.history.replaceState(null, '', '/login');
    render(<App runtime={createRuntime()} />);
    expect(screen.getByText('Sample mode')).toBeVisible();
    expect(screen.getByLabelText('Sample email')).toHaveAttribute('readonly');
    fireEvent.click(
      screen.getByRole('link', { name: 'Try sample without signing in' }),
    );
    await screen.findByRole('list', { name: 'Saved games' });
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    for (const img of document.querySelectorAll('img'))
      expect(img.getAttribute('src')).toMatch(/^\/art\//);
  });
  it.each(['', 'API', 'live', ' sample '])(
    'fails closed on an invalid data source: %j',
    (source) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      render(<App runtime={createRuntime(source)} />);
      expect(screen.getByRole('alert')).toHaveTextContent('VITE_DATA_SOURCE');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('real cookie session screens', () => {
  it('waits for /me before private requests, then shows sign-in on 401', async () => {
    const me = deferred<Response>();
    const { fetch } = open('/watchlist', (path) =>
      path.endsWith('/me') ? me.promise : undefined,
    );
    expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => me.resolve(json(error('AUTH_REQUIRED'), 401)));
    expect(await screen.findByText('Sign in to continue')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('list', { name: 'Saved games' }),
    ).not.toBeInTheDocument();
  });
  it('shows unknown/offline restore with explicit retry rather than pretending signed out', async () => {
    let attempts = 0;
    const { fetch } = open('/watchlist', (path) =>
      path.endsWith('/me')
        ? ++attempts === 1
          ? json(error('INTERNAL_ERROR'), 500)
          : json(user)
        : json({ items: [], page }),
    );
    expect(
      await screen.findByText('Session could not be checked'),
    ).toBeVisible();
    expect(screen.getByText(/This is not a sign-out/)).toBeVisible();
    expect(screen.queryByText('Sign in to continue')).not.toBeInTheDocument();
    click('Retry session');
    expect(
      await screen.findByText('Make room for your next game'),
    ).toBeVisible();
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/me')),
    ).toHaveLength(2);
  });
  it('logs in with real fields, cookie credentials and rotated CSRF, without browser credential storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const { fetch, unexpected } = open(
      '/login',
      (path) => {
        if (path.endsWith('/login')) return json(login);
        if (path.startsWith('/api/tracked-items?'))
          return json({ items: [item], page });
      },
      null,
      true,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    change('Email', user.email);
    change('Password', '  preserve password spaces  ');
    click('Sign in');
    expect(
      await screen.findByRole('list', { name: 'Saved games' }),
    ).toHaveTextContent('Portal 2');
    const request = fetch.mock.calls.find(([url]) =>
      String(url).endsWith('/login'),
    )!;
    expect(request[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        email: user.email,
        password: '  preserve password spaces  ',
      }),
    });
    expect(request[1]?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    });
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/csrf')),
    ).toHaveLength(2);
    expect(document.title).not.toContain('sample');
    expect(screen.queryByText(/Illustrative sample/)).not.toBeInTheDocument();
    expect(storage).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(unexpected).toEqual([]);
  });
  it('shows EMAIL_UNVERIFIED and generic account email responses without pretending sign-in', async () => {
    const { client, unexpected } = open(
      '/login',
      (path) =>
        path.endsWith('/login')
          ? json(error('EMAIL_UNVERIFIED'), 403)
          : path.endsWith('/resend-verification')
            ? json(accepted, 202)
            : undefined,
      null,
    );
    await screen.findByRole('heading', { name: 'Welcome back.' });
    change('Email', user.email);
    change('Password', 'password');
    click('Sign in');
    fireEvent.click(
      await screen.findByRole('link', { name: 'Verify or resend email' }),
    );
    change('Email', user.email);
    click('Resend verification email');
    expect(await screen.findByText(accepted.message)).toBeVisible();
    expect(client.getSession().status).toBe('anonymous');
    expect(unexpected).toEqual([]);
  });
  it('registers with optional name and sends forgot-password requests through the actual API', async () => {
    const { fetch, client, unexpected } = open(
      '/register',
      (path) =>
        path.endsWith('/register') || path.endsWith('/forgot-password')
          ? json(accepted, 202)
          : undefined,
      null,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).toBeEnabled(),
    );
    change('Email', user.email);
    change('Name (optional)', 'Player');
    change('Password', 'example-password');
    change('Confirm password', 'example-password');
    click('Create account');
    expect(await screen.findByText(accepted.message)).toBeVisible();
    const register = fetch.mock.calls.find(([url]) =>
      String(url).endsWith('/register'),
    )!;
    expect(JSON.parse(register[1]!.body as string)).toEqual({
      email: user.email,
      password: 'example-password',
      name: 'Player',
    });
    fireEvent.click(
      screen.getByRole('link', { name: 'Request password reset' }),
    );
    change('Email', user.email);
    click('Send reset email');
    expect(await screen.findByText(accepted.message)).toBeVisible();
    expect(client.getSession().status).toBe('anonymous');
    expect(unexpected).toEqual([]);
  });
  it('clears private data on a resource 401 and never replaces it with sample rows', async () => {
    const { client, unexpected } = open('/watchlist', (path) => {
      if (path.startsWith('/api/tracked-items?'))
        return json({ items: [item], page });
      if (path.includes('/tracked-items/tracker_example'))
        return json(error('SESSION_EXPIRED'), 401);
    });
    await screen.findByRole('list', { name: 'Saved games' });
    fireEvent.click(
      screen.getByRole('link', { name: 'Details for Portal 2' }),
    );
    expect(await screen.findByText('Sign in to continue')).toBeVisible();
    expect(client.getSession().status).toBe('anonymous');
    expect(document.title).not.toContain('Portal 2');
    expect(screen.queryByText('Portal 2')).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('logs out bodylessly, clears private screens, and protects browser-back navigation', async () => {
    const { fetch, client, unexpected } = open('/account', (path) =>
      path.endsWith('/logout')
        ? new Response(null, { status: 204 })
        : undefined,
    );
    expect(await screen.findByText(user.email)).toBeVisible();
    click('Sign out');
    expect(await screen.findByText('Sign in to continue')).toBeVisible();
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith('/csrf')),
      ).toHaveLength(2),
    );
    const logout = fetch.mock.calls.find(([url]) =>
      String(url).endsWith('/logout'),
    )!;
    expect(logout[1]?.body).toBeUndefined();
    expect(logout[1]?.headers).toEqual({
      Accept: 'application/json',
      'X-CSRF-Token': token,
    });
    expect(client.getSession().status).toBe('anonymous');
    fireEvent.click(screen.getByRole('link', { name: 'Watchlist' }));
    expect(await screen.findByText('Sign in to continue')).toBeVisible();
    expect(screen.queryByText(user.email)).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('keeps a confirmed login honest when post-login CSRF bootstrap fails', async () => {
    let bootstraps = 0;
    const { unexpected } = open(
      '/login',
      (path) => {
        if (path.endsWith('/csrf'))
          return ++bootstraps === 1
            ? json(csrf())
            : json({ malformed: true });
        if (path.endsWith('/login')) return json(login);
      },
      null,
    );
    change('Email', user.email);
    change('Password', 'password');
    click('Sign in');
    expect(
      await screen.findByText(/Signed in. CSRF initialization failed/),
    ).toBeVisible();
    expect(screen.getByText(user.email)).toBeVisible();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('reports offline logout without claiming revocation or silently switching to sample mode', async () => {
    const { client, unexpected } = open('/account', (path) =>
      path.endsWith('/logout')
        ? Promise.reject(new TypeError('offline'))
        : undefined,
    );
    await screen.findByText(user.email);
    click('Sign out');
    expect(await screen.findByText(/Could not reach the API/)).toBeVisible();
    expect(screen.getByText(user.email)).toBeVisible();
    expect(client.getSession().status).toBe('authenticated');
    expect(screen.queryByText('Sample mode')).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
});

describe('browser email link handoff', () => {
  it.each(['/verify-email', '/verify'])(
    'strips %s fragment immediately and consumes only on explicit POST',
    async (path) => {
      const { fetch, client, unexpected } = open(
        `${path}#token=${token}`,
        (url) =>
          url.endsWith('/verify-email')
            ? new Response(null, { status: 204 })
            : undefined,
        null,
        true,
      );
      expect(location.hash).toBe('');
      expect(location.search).toBe('');
      expect(JSON.stringify(window.history.state)).not.toContain(token);
      expect(
        fetch.mock.calls.every(([url]) => String(url).endsWith('/me')),
      ).toBe(true);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Verify email' }),
        ).toBeEnabled(),
      );
      click('Verify email');
      expect(
        await screen.findByText(/Email verified. Sign in separately/),
      ).toBeVisible();
      const verify = fetch.mock.calls.find(([url]) =>
        String(url).endsWith('/verify-email'),
      )!;
      expect(verify[1]).toMatchObject({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ token }),
      });
      expect(verify[1]?.headers).toMatchObject({ 'X-CSRF-Token': token });
      expect(client.getSession().status).not.toBe('authenticated');
      expect(unexpected).toEqual([]);
    },
  );
  it('strips reset fragments, requires a matching password confirmation, and never auto-logs in', async () => {
    const { fetch, client, unexpected } = open(
      `/reset-password#token=${token}`,
      (path) =>
        path.endsWith('/reset-password')
          ? new Response(null, { status: 204 })
          : undefined,
      null,
    );
    expect(location.hash).toBe('');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reset password' }),
      ).toBeEnabled(),
    );
    change('New password', 'changed-password');
    change('Confirm password', 'not-matching');
    click('Reset password');
    expect(
      await screen.findByText('The passwords do not match.'),
    ).toBeVisible();
    expect(
      fetch.mock.calls.every(([url]) => String(url).endsWith('/me')),
    ).toBe(true);
    change('Confirm password', 'changed-password');
    click('Reset password');
    expect(
      await screen.findByText(/Password reset. All sessions were revoked/),
    ).toBeVisible();
    const reset = fetch.mock.calls.find(([url]) =>
      String(url).endsWith('/reset-password'),
    )!;
    expect(reset[1]?.body).toBe(
      JSON.stringify({ token, password: 'changed-password' }),
    );
    expect(client.getSession().status).toBe('anonymous');
    expect(unexpected).toEqual([]);
  });
  it('rejects query tokens and malformed/missing fragment tokens without automatic consumption', async () => {
    const { fetch } = open(
      `/reset-password?token=${token}`,
      () => undefined,
      null,
    );
    expect(location.search).toBe('');
    expect(
      screen.getByRole('button', { name: 'Reset password' }),
    ).toBeDisabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth/web/me');
  });
});

describe('live tracker screens', () => {
  it.each([true, false])(
    'keeps a real zero price distinct from a missing offer: free=%s',
    async (free) => {
      const offer = free
        ? {
            ...product,
            currentPrice: { amountMinor: 0, currency: 'USD' as const },
          }
        : unavailableProduct;
      const { unexpected } = open(`/watchlist/${item.id}`, (path) =>
        path.includes('/history?')
          ? json({ ...history, product: offer, items: [] })
          : path === `/api/tracked-items/${item.id}`
            ? json({ ...item, product: offer })
            : undefined,
      );
      await screen.findByRole('heading', { name: 'Portal 2' });
      if (free)
        expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
      else {
        expect(screen.getByText('Price unavailable')).toBeVisible();
        expect(
          screen.queryByRole('link', { name: /Open Steam deal/ }),
        ).not.toBeInTheDocument();
      }
      expect(await screen.findByText('No observations yet')).toBeVisible();
      expect(
        screen.queryByText(/Illustrative sample history/),
      ).not.toBeInTheDocument();
      expect(unexpected).toEqual([]);
    },
  );
  it('cancels an in-flight preview on navigation and never restores its private draft later', async () => {
    const preview = deferred<Response>();
    const { fetch, unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews') return preview.promise;
      if (path.startsWith('/api/tracked-items?'))
        return json({ items: [], page });
    });
    await screen.findByRole('button', { name: 'Use Portal 2 link' });
    click('Use Portal 2 link');
    click('Preview offer');
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => url === '/api/product-previews'),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Watchlist' }));
    await screen.findByText('Make room for your next game');
    expect(
      fetch.mock.calls.find(([url]) => url === '/api/product-previews')?.[1]
        ?.signal?.aborted,
    ).toBe(true);
    await act(async () =>
      preview.resolve(
        json(
          { id: 'old_preview', expiresAt: csrf().expiresAt, product },
          201,
        ),
      ),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Add game' }));
    expect(await screen.findByLabelText('Steam base-game URL')).toHaveValue(
      '',
    );
    expect(
      screen.queryByLabelText('Target price (USD)'),
    ).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('clears old-account detail/history and ignores late outcomes when the session switches accounts', async () => {
    const detail = deferred<Response>();
    let reads = 0;
    const secondItem = {
      ...item,
      product: { ...product, title: 'Account B game' },
    };
    const { client, fetch, unexpected } = open(
      `/watchlist/${item.id}`,
      (path) => {
        if (path === `/api/tracked-items/${item.id}`)
          return ++reads === 1 ? detail.promise : json(secondItem);
        if (path.includes('/history?'))
          return json({
            ...history,
            product: reads <= 1 ? product : secondItem.product,
            items: [],
          });
        if (path.endsWith('/login'))
          return json({
            ...login,
            sessionId: 'session_B',
            user: { ...user, id: 'user_B' },
          });
      },
    );
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => {
      await client.login({ email: user.email, password: 'password' });
    });
    expect(
      await screen.findByRole('heading', { name: 'Account B game' }),
    ).toBeVisible();
    expect(
      fetch.mock.calls.find(
        ([url]) => url === `/api/tracked-items/${item.id}`,
      )?.[1]?.signal?.aborted,
    ).toBe(true);
    await act(async () => detail.resolve(json(item)));
    expect(
      screen.queryByRole('heading', { name: 'Portal 2' }),
    ).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('shows Retry-After and blocks an explicit save retry until the wait passes', async () => {
    let saves = 0;
    const { fetch, unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews')
        return json(
          { id: 'preview_example', expiresAt: csrf().expiresAt, product },
          201,
        );
      if (path === '/api/tracked-items') {
        saves++;
        return json(error('RATE_LIMITED', 2), 429, { 'Retry-After': '2' });
      }
    });
    await screen.findByRole('button', { name: 'Use Portal 2 link' });
    click('Use Portal 2 link');
    click('Preview offer');
    await screen.findByLabelText('Target price (USD)');
    change('Target price (USD)', '0');
    vi.useFakeTimers();
    click('Save game');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByText('Wait at least 2 seconds before trying again.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save game' })).toBeDisabled();
    expect(saves).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('button', { name: 'Save game' })).toBeEnabled();
    click('Save game');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saves).toBe(2);
    expect(
      fetch.mock.calls.filter(([url]) => url === '/api/tracked-items')[0]?.[1]
        ?.headers,
    ).toEqual(
      fetch.mock.calls.filter(([url]) => url === '/api/tracked-items')[1]?.[1]
        ?.headers,
    );
    expect(unexpected).toEqual([]);
  });
  it('retains API search field focus, cancels superseded searches, and never displays stale results', async () => {
    const pending = deferred<Response>();
    const { fetch, unexpected } = open('/watchlist', (path) => {
      if (path === '/api/tracked-items?limit=100')
        return json({ items: [item], page });
      if (path === '/api/tracked-items?limit=100&q=P') return pending.promise;
      if (path === '/api/tracked-items?limit=100&q=Portal')
        return json({ items: [], page });
    });
    await screen.findByRole('list', { name: 'Saved games' });
    const input = screen.getByLabelText('Search saved games');
    input.focus();
    change('Search saved games', 'P');
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => String(url).endsWith('&q=P')),
      ).toBe(true),
    );
    // The toolbar must stay available while a server search is pending.
    expect(input).toHaveFocus();
    change('Search saved games', 'Portal');
    expect(await screen.findByText('No saved games match')).toBeVisible();
    await act(async () => pending.resolve(json({ items: [item], page })));
    expect(
      screen.queryByRole('heading', { name: 'Portal 2' }),
    ).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('previews, saves a zero target, and shows real retained history/metadata, with no remote image or invented series', async () => {
    const { fetch, unexpected } = open('/add', (path, init) => {
      if (path === '/api/product-previews')
        return json(
          {
            id: 'preview_example',
            expiresAt: csrf().expiresAt,
            product: {
              ...product,
              imageUrl: 'https://untrusted.example/art.jpg',
            },
          },
          201,
        );
      if (path === '/api/tracked-items' && init.method === 'POST')
        return json(item, 201);
      if (path === `/api/tracked-items/${item.id}`) return json(item);
      if (path === `/api/tracked-items/${item.id}/history?limit=100`)
        return json(history);
    });
    await screen.findByRole('button', { name: 'Use Portal 2 link' });
    click('Use Portal 2 link');
    click('Preview offer');
    await screen.findByLabelText('Target price (USD)');
    change('Target price (USD)', '0');
    click('Save game');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Portal 2' }),
    ).toBeVisible();
    expect(
      await screen.findByText(
        'Successful observations of this Steam offer via CheapShark.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/Illustrative sample history/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Observation window/)).toHaveTextContent(
      history.retainedFrom,
    );
    expect(screen.getByText('Last attempt')).toBeVisible();
    const save = fetch.mock.calls.find(
      ([url, init]) =>
        url === '/api/tracked-items' && init?.method === 'POST',
    )!;
    expect(JSON.parse(save[1]!.body as string)).toEqual({
      previewId: 'preview_example',
      targetPrice: { amountMinor: 0, currency: 'USD' },
      enabled: true,
      alerts: { email: true, push: false },
    });
    expect(save[1]?.headers).toMatchObject({
      'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/),
      'X-CSRF-Token': token,
    });
    expect(
      screen.getByRole('link', { name: /Open Steam deal/ }),
    ).toHaveAttribute('href', product.purchaseUrl);
    for (const img of document.querySelectorAll('img'))
      expect(img.getAttribute('src')).toMatch(/^\/art\//);
    expect(unexpected).toEqual([]);
  });
  it('surfaces server validation fields and an owned duplicate with a useful link', async () => {
    let attempts = 0;
    const { unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews')
        return ++attempts === 1
          ? json(
              {
                error: {
                  ...error('VALIDATION_ERROR').error,
                  fields: [
                    {
                      path: '/url',
                      code: 'unsupported',
                      message: 'This base game is not supported.',
                    },
                  ],
                },
              },
              422,
            )
          : json(
              { id: 'preview_example', expiresAt: csrf().expiresAt, product },
              201,
            );
      if (path === '/api/tracked-items')
        return json(
          {
            error: {
              ...error('DUPLICATE_TRACKED_ITEM').error,
              resourceId: item.id,
            },
          },
          409,
        );
    });
    await screen.findByRole('button', { name: 'Use Portal 2 link' });
    click('Use Portal 2 link');
    click('Preview offer');
    expect(
      await screen.findByText('/url: This base game is not supported.'),
    ).toBeVisible();
    click('Preview offer');
    await screen.findByLabelText('Target price (USD)');
    change('Target price (USD)', '0');
    click('Save game');
    expect(
      await screen.findByRole('link', { name: 'Open existing tracker' }),
    ).toHaveAttribute('href', `/watchlist/${item.id}`);
    expect(unexpected).toEqual([]);
  });
  it('reuses the same UUID and body for an explicit uncertain-save retry', async () => {
    let saves = 0;
    const { fetch, unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews')
        return json(
          { id: 'preview_example', expiresAt: csrf().expiresAt, product },
          201,
        );
      if (path === '/api/tracked-items')
        return ++saves === 1
          ? Promise.reject(new TypeError('offline'))
          : json(item, 201);
      if (path === `/api/tracked-items/${item.id}`) return json(item);
      if (path.startsWith(`/api/tracked-items/${item.id}/history`))
        return json(history);
    });
    await screen.findByRole('button', { name: 'Use Portal 2 link' });
    click('Use Portal 2 link');
    click('Preview offer');
    await screen.findByLabelText('Target price (USD)');
    change('Target price (USD)', '0');
    click('Save game');
    expect(await screen.findByText(/Could not reach the API/)).toBeVisible();
    expect(saves).toBe(1);
    click('Save game');
    await screen.findByRole('heading', { level: 1, name: 'Portal 2' });
    const requests = fetch.mock.calls.filter(
      ([url]) => url === '/api/tracked-items',
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.[1]?.body).toBe(requests[1]?.[1]?.body);
    expect(requests[0]?.[1]?.headers).toEqual(requests[1]?.[1]?.headers);
    expect(unexpected).toEqual([]);
  });
  it('loads paginated search results and every authorized history page rather than silently taking page one', async () => {
    const second = {
      ...item,
      id: 'second',
      product: { ...product, id: 'product_second', title: 'Portal second' },
    };
    const { fetch, unexpected } = open('/watchlist?q=Portal', (path) => {
      if (path === '/api/tracked-items?limit=100&q=Portal')
        return json({
          items: [item],
          page: { limit: 100, nextCursor: 'next+/=' },
        });
      if (
        path === '/api/tracked-items?limit=100&cursor=next%2B%2F%3D&q=Portal'
      )
        return json({ items: [second], page });
      if (path === `/api/tracked-items/${item.id}`) return json(item);
      if (path === `/api/tracked-items/${item.id}/history?limit=100`)
        return json({ ...history, page: { limit: 100, nextCursor: 'more' } });
      if (path.includes('/history?limit=100&cursor=more&from='))
        return json({
          ...history,
          items: [
            {
              ...history.items[0],
              id: 'other_observation',
              observedAt: '2026-10-27T16:34:42.829Z',
            },
          ],
          page,
        });
    });
    const list = await screen.findByRole('list', { name: 'Saved games' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('link', { name: 'Details for Portal 2' }),
    );
    await screen.findByText(/Successful Steam observations\./);
    expect(screen.getAllByRole('row', { hidden: true })).toHaveLength(3);
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).includes('cursor=more&from=2026-10-01T00%3A00%3A00Z&to='),
      ),
    ).toBe(true);
    expect(unexpected).toEqual([]);
  });
  it('edits only preferences and removes a tracker only after confirmation', async () => {
    const updated = {
      ...item,
      enabled: false,
      targetPrice: { amountMinor: 250, currency: 'USD' as const },
    };
    let current = item;
    const { fetch, unexpected } = open(
      `/watchlist/${item.id}/edit`,
      (path, init) => {
        if (
          path === `/api/tracked-items/${item.id}` &&
          init.method === 'PATCH'
        ) {
          current = updated;
          return json(updated);
        }
        if (
          path === `/api/tracked-items/${item.id}` &&
          init.method === 'DELETE'
        )
          return new Response(null, { status: 204 });
        if (path === `/api/tracked-items/${item.id}`) return json(current);
        if (path.includes('/history?'))
          return json({ ...history, items: [] });
        if (path.startsWith('/api/tracked-items?'))
          return json({ items: [], page });
      },
    );
    await screen.findByLabelText('Target price (USD)');
    change('Target price (USD)', '2.50');
    click('Save changes');
    await screen.findByRole('heading', { level: 1, name: 'Portal 2' });
    const patch = fetch.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    )!;
    expect(JSON.parse(patch[1]!.body as string)).toEqual({
      targetPrice: { amountMinor: 250, currency: 'USD' },
      enabled: true,
      alerts: { email: true, push: false },
    });
    click('Remove game');
    expect(
      fetch.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);
    click('Remove from watchlist');
    expect(
      await screen.findByText('Make room for your next game'),
    ).toBeVisible();
    const removal = fetch.mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    )!;
    expect(removal[1]?.body).toBeUndefined();
    expect(unexpected).toEqual([]);
  });
});
