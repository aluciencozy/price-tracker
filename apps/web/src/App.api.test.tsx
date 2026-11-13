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
  it('defaults release builds to the API and rejects an explicitly configured sample', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_DATA_SOURCE', undefined);
    expect(createRuntime().mode).toBe('api');
    expect(createRuntime('sample').mode).toBe('invalid');
  });
  it('keeps development controls and fixture content out of the production account flow', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    open('/', () => undefined, null);
    for (const link of await screen.findAllByRole('link', { name: 'Sign in' }))
      expect(link).toHaveAttribute('href', '/login');
    for (const link of screen.getAllByRole('link', { name: 'Create account' }))
      expect(link).toHaveAttribute('href', '/register');
    expect(screen.queryByText('Development tools')).not.toBeInTheDocument();
    expect(screen.queryByText('API mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Sample mode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Example tracker')).not.toBeInTheDocument();
    expect(screen.queryByText('$9.99')).not.toBeInTheDocument();
  });
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
  it('adapts homepage actions and the header to an authenticated session', async () => {
    open('/');
    await screen.findByText('Your watchlist and alert settings are private to your account.');
    const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    expect(nav.getByRole('link', { name: 'Watchlist' })).toBeVisible();
    expect(nav.getByRole('link', { name: 'Account' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
  });

  it('keeps signed-out homepage actions available', async () => {
    const { client } = open('/', () => undefined, null);
    await waitFor(() => expect(client.getSession().status).toBe('anonymous'));
    const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
    expect(nav.getByRole('link', { name: 'Sign in' })).toBeVisible();
    expect(nav.getByRole('link', { name: 'Create account' })).toBeVisible();
    expect(nav.queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
  });
  it('waits for /me before private requests, then shows sign-in on 401', async () => {
    const me = deferred<Response>();
    const { fetch } = open('/watchlist', (path) =>
      path.endsWith('/me') ? me.promise : undefined,
    );
    expect(screen.getByText('Restoring your session…')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => me.resolve(json(error('AUTH_REQUIRED'), 401)));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Sign in to continue',
      }),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('list', { name: 'Saved games' }),
    ).not.toBeInTheDocument();
  });
  it.each(['/watchlist', '/account'])(
    'renders a signed-out H1 on %s without requesting private data',
    async (path) => {
      const { client, fetch, unexpected } = open(
        path,
        (requestPath) =>
          requestPath.endsWith('/me')
            ? json(error('AUTH_REQUIRED'), 401)
            : undefined,
        null,
      );

      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'Sign in to continue',
        }),
      ).toBeVisible();
      expect(client.getSession().status).toBe('anonymous');
      expect(fetch).toHaveBeenCalledTimes(1);
      const [mePath, meRequest] = fetch.mock.calls[0]!;
      expect(mePath).toBe('/api/auth/web/me');
      expect(meRequest).toMatchObject({ method: 'GET' });
      expect(
        within(screen.getByRole('main')).getByRole('link', {
          name: 'Sign in',
        }),
      ).toHaveAttribute('href', '/login');
      expect(
        screen.queryByRole('list', { name: 'Saved games' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Sign out' }),
      ).not.toBeInTheDocument();
      expect(unexpected).toEqual([]);
    },
  );
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
      await screen.findByText('Your watchlist is empty'),
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
    await screen.findByRole('heading', { name: 'Sign in' });
    change('Email', user.email);
    change('Password', 'password');
    click('Sign in');
    fireEvent.click(
      await screen.findByRole('link', { name: 'Verify or resend email' }),
    );
    expect(screen.getByLabelText('Email')).toHaveValue(user.email);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(JSON.stringify(window.history.state)).not.toContain('password');
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
  it('takes a newly registered user to verification with their email and no password', async () => {
    const { client } = open('/register', path => path.endsWith('/register') ? json(accepted, 202) : undefined, null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled());
    change('Email', user.email);
    change('Password', 'fixture-password');
    change('Confirm password', 'fixture-password');
    click('Create account');
    fireEvent.click(await screen.findByRole('link', { name: 'Verify or resend email' }));
    expect(screen.getByLabelText('Email')).toHaveValue(user.email);
    expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeEnabled();
    expect(JSON.stringify(window.history.state)).not.toContain('fixture-password');
    expect(client.getSession().status).toBe('anonymous');
  });
  it('associates server field errors with account inputs and allows an explicit corrected retry', async () => {
    let attempts = 0;
    const invalid = { error: { ...error('VALIDATION_ERROR').error,
      fields: [{ path: '/email', code: 'invalid_format', message: 'Use an email address with at most 254 characters.' }] } };
    const { fetch } = open('/forgot', path => path.endsWith('/forgot-password')
      ? ++attempts === 1 ? json(invalid, 422) : json(accepted, 202) : undefined, null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send reset email' })).toBeEnabled());
    change('Email', user.email);
    click('Send reset email');
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Use an email address with at most 254 characters.');
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/forgot-password'))).toHaveLength(1);
    change('Email', 'corrected@example.invalid');
    click('Send reset email');
    expect(await screen.findByText(accepted.message)).toBeVisible();
    expect(attempts).toBe(2);
  });
  it('blocks overlapping verification and resend submissions until the first request settles', async () => {
    const pending = deferred<Response>();
    const { fetch } = open(`/verify-email#token=${token}`, path => path.endsWith('/verify-email') ? pending.promise : undefined, null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify email' })).toBeEnabled());
    change('Email', user.email);
    const verifyForm = screen.getByRole('button', { name: 'Verify email' }).closest('form')!;
    const resendForm = screen.getByRole('button', { name: 'Resend verification email' }).closest('form')!;
    act(() => {
      fireEvent.submit(verifyForm);
      fireEvent.submit(verifyForm);
      fireEvent.submit(resendForm);
    });
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/verify-email'))).toHaveLength(1));
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/resend-verification'))).toBe(false);
    pending.resolve(new Response(null, { status: 204 }));
    expect(await screen.findByText(/Email verified. Sign in separately/)).toBeVisible();
  });
  it('honors an account rate limit without replaying the mutation', async () => {
    const { fetch } = open('/forgot', path => path.endsWith('/forgot-password') ? json(error('RATE_LIMITED', 60), 429) : undefined, null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send reset email' })).toBeEnabled());
    change('Email', user.email);
    click('Send reset email');
    expect(await screen.findByText(/Retry available in/)).toBeVisible();
    const button = screen.getByRole('button', { name: 'Send reset email' });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form')!);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/forgot-password'))).toHaveLength(1);
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
  it('submits sign-out once while its API request is pending', async () => {
    const pending = deferred<Response>();
    const { fetch } = open('/account', path => path.endsWith('/logout') ? pending.promise : undefined);
    await screen.findByText(user.email);
    const button = screen.getByRole('button', { name: 'Sign out' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/logout'))).toHaveLength(1));
    pending.resolve(new Response(null, { status: 204 }));
    expect(await screen.findByText('Sign in to continue')).toBeVisible();
  });
  it('discards a pending account result after navigating away', async () => {
    const pending = deferred<Response>();
    const { fetch } = open('/forgot', path => path.endsWith('/forgot-password') ? pending.promise : undefined, null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send reset email' })).toBeEnabled());
    change('Email', user.email);
    click('Send reset email');
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/forgot-password'))).toBe(true));
    fireEvent.click(screen.getByRole('link', { name: 'Back to sign in' }));
    const request = fetch.mock.calls.find(([url]) => String(url).endsWith('/forgot-password'))!;
    expect(request[1]?.signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(json(accepted, 202)); });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.queryByText(accepted.message)).not.toBeInTheDocument();
  });
});

describe('browser email link handoff', () => {
  it.each(['/verify-email', '/reset-password'])(
    'offers recovery for an expired or consumed %s link without automatic replay', async path => {
      const { fetch } = open(`${path}#token=${token}`, url => url.endsWith(path) ? json(error('TOKEN_INVALID'), 400) : undefined, null);
      const buttonName = path === '/verify-email' ? 'Verify email' : 'Reset password';
      await waitFor(() => expect(screen.getByRole('button', { name: buttonName })).toBeEnabled());
      if (path === '/reset-password') {
        change('New password', 'fixture-password');
        change('Confirm password', 'fixture-password');
      }
      click(buttonName);
      expect(await screen.findByText('Illustrative error.')).toBeVisible();
      expect(screen.getByRole('link', { name: 'Request password reset' })).toBeVisible();
      if (path === '/verify-email') expect(screen.getByRole('button', { name: 'Resend verification email' })).toBeVisible();
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(path))).toHaveLength(1);
    },
  );
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
  it('does not offer save controls when the API reports no current Steam offer', async () => {
    const { fetch, unexpected } = open('/add', (path) =>
      path === '/api/product-previews'
        ? json(
            {
              error: {
                ...error('STEAM_OFFER_UNAVAILABLE').error,
                message: 'No current Steam offer is available.',
              },
            },
            422,
          )
        : undefined,
    );
    const url = 'https://store.steampowered.com/app/620/';
    await screen.findByLabelText('Steam app URL');
    change('Steam app URL', url);
    click('Preview offer');

    expect(
      await screen.findByText('No current Steam offer is available.'),
    ).toBeVisible();
    expect(screen.queryByLabelText('Target price (USD)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save game' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([path]) => path === '/api/tracked-items')).toBe(false);
    expect(unexpected).toEqual([]);
  });
  it('cancels an in-flight preview on navigation and never restores its private draft later', async () => {
    const preview = deferred<Response>();
    const { fetch, unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews') return preview.promise;
      if (path.startsWith('/api/tracked-items?'))
        return json({ items: [], page });
    });
      fireEvent.change(await screen.findByLabelText('Steam app URL'), { target: { value: 'https://store.steampowered.com/app/620/' } });
    click('Preview offer');
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => url === '/api/product-previews'),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Watchlist' }));
    await screen.findByText('Your watchlist is empty');
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
    expect(await screen.findByLabelText('Steam app URL')).toHaveValue(
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
      if (path === '/api/tracked-items?limit=100') return json({ items: [], page });
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
    fireEvent.change(await screen.findByLabelText('Steam app URL'), { target: { value: 'https://store.steampowered.com/app/620/' } });
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
  it('blocks API preferences for a duplicate discovered during preview', async () => {
    const lookup = deferred<Response>();
    const { fetch, unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews') return json({ id: 'preview_example', expiresAt: csrf().expiresAt, product }, 201);
      if (path === '/api/tracked-items?limit=100') return lookup.promise;
    });
    await screen.findByLabelText('Steam app URL');
    change('Steam app URL', 'https://store.steampowered.com/app/620/');
    click('Preview offer');
    await screen.findByRole('button', { name: 'Checking your watchlist…' });
    expect(screen.queryByLabelText('Target price (USD)')).not.toBeInTheDocument();
    await act(async () => lookup.resolve(json({ items: [item], page })));
    expect(await screen.findByRole('link', { name: 'Open existing tracker' })).toHaveAttribute('href', `/watchlist/${item.id}`);
    expect(screen.queryByLabelText('Target price (USD)')).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([path]) => path === '/api/tracked-items')).toBe(false);
    expect(unexpected).toEqual([]);
  });

  it('requires retry after duplicate lookup failure and reuses the offer preview', async () => {
    let lookups = 0;
    const { fetch, unexpected } = open('/add', (path) => {
      if (path === '/api/product-previews') return json({ id: 'preview_example', expiresAt: csrf().expiresAt, product }, 201);
      if (path === '/api/tracked-items?limit=100') return ++lookups === 1
        ? json(error('VALIDATION_ERROR'), 422) : json({ items: [], page });
    });
    await screen.findByLabelText('Steam app URL');
    change('Steam app URL', 'https://store.steampowered.com/app/620/');
    click('Preview offer');
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByLabelText('Target price (USD)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Steam app URL')).toHaveValue('https://store.steampowered.com/app/620/');
    click('Retry');
    await screen.findByLabelText('Target price (USD)');
    expect(fetch.mock.calls.filter(([path]) => path === '/api/product-previews')).toHaveLength(1);
    expect(unexpected).toEqual([]);
  });

  it('retains previous search results on failure and clears private results on expiry', async () => {
    let fail = true;
    const { client, unexpected } = open('/watchlist', (path) => {
      if (path === '/api/tracked-items?limit=100') return json({ items: [item], page });
      if (path === '/api/tracked-items?limit=100&q=missing') return fail
        ? json(error('VALIDATION_ERROR'), 422) : json({ items: [], page });
      if (path === '/api/tracked-items?limit=100&q=expired') return json(error('SESSION_EXPIRED'), 401);
    });
    await screen.findByRole('list', { name: 'Saved games' });
    change('Search saved games', 'missing');
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('list', { name: 'Previous saved-game results' })).toBeVisible();
    expect(screen.getByLabelText('Search saved games')).toHaveValue('missing');
    fail = false;
    click('Retry');
    await screen.findByText('No saved games match');
    click('Clear search');
    await screen.findByRole('heading', { name: 'Portal 2' });
    change('Search saved games', 'expired');
    await screen.findByText('Sign in to continue');
    expect(screen.queryByRole('heading', { name: 'Portal 2' })).not.toBeInTheDocument();
    expect(client.getSession().status).toBe('anonymous');
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
    expect(screen.getByText('Searching…')).toBeVisible();
    expect(screen.getByText(/Previous results/)).toBeVisible();
    expect(screen.getByRole('list', { name: 'Previous saved-game results' })).toBeVisible();
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => String(url).endsWith('&q=P')),
      ).toBe(true),
    );
    // The toolbar must stay available while a server search is pending.
    expect(input).toHaveFocus();
    change('Search saved games', 'Portal');
    expect(await screen.findByText('No saved games match')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add your first game' })).not.toBeInTheDocument();
    await act(async () => pending.resolve(json({ items: [item], page })));
    expect(
      screen.queryByRole('heading', { name: 'Portal 2' }),
    ).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });
  it('previews, saves a zero target, and shows real retained history/metadata, with no remote image or invented series', async () => {
    const { fetch, unexpected } = open('/add', (path, init) => {
      if (path === '/api/tracked-items?limit=100') return json({ items: [], page });
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
    fireEvent.change(await screen.findByLabelText('Steam app URL'), { target: { value: 'https://store.steampowered.com/app/620/' } });
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
    expect(await screen.findByText('Last-known price preserved')).toBeVisible();
    expect(screen.getByText('Illustrative failure.')).toBeVisible();
    expect(screen.getAllByText('$9.99').length).toBeGreaterThan(0);
    expect(
      screen.queryByText(/Illustrative sample history/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Observation window/)).toHaveTextContent(
      history.retainedFrom,
    );
    fireEvent.click(screen.getByText('Price details'));
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
      screen.getByRole('link', { name: /View Steam offer/ }),
    ).toHaveAttribute('href', product.purchaseUrl);
    for (const img of document.querySelectorAll('img'))
      expect(img.getAttribute('src')).toMatch(/^\/art\//);
    expect(unexpected).toEqual([]);
  });
  it('uses an API-returned synthetic Brotato through preview, CRUD, list, and empty history without sample fallback', async () => {
    const url = 'https://store.steampowered.com/app/1942280/';
    const trackerId = 'tracker_brotato_fixture';
    // Synthetic provider ID/offer payload for client coverage only; not source proof.
    const brotato = {
      ...product,
      id: 'product_brotato_fixture',
      identity: { ...product.identity, providerGameId: '90001' },
      steamAppId: '1942280',
      canonicalSteamUrl: url,
      title: 'Brotato',
      currentPrice: { amountMinor: 0, currency: 'USD' as const },
      imageUrl: null,
    };
    const previewValue = {
      id: 'preview_brotato_fixture',
      expiresAt: csrf().expiresAt,
      product: brotato,
    };
    const emptyHistory = {
      ...history,
      trackedItemId: trackerId,
      product: brotato,
      items: [],
    };
    let current = {
      ...item,
      id: trackerId,
      product: brotato,
      alerts: { email: false, push: false },
    };
    let saved = false;
    const { fetch, unexpected } = open('/add', (path, init) => {
      if (path === '/api/product-previews')
        return json(previewValue, 201);
      if (path.startsWith('/api/tracked-items?'))
        return json({ items: saved ? [current] : [], page });
      if (path === `/api/tracked-items/${trackerId}/history?limit=100`)
        return json(emptyHistory);
      if (path === `/api/tracked-items/${trackerId}` && init.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        current = {
          ...current,
          targetPrice: body.targetPrice,
          enabled: body.enabled,
          alerts: body.alerts,
        };
        return json(current);
      }
      if (path === `/api/tracked-items/${trackerId}` && init.method === 'DELETE') {
        saved = false;
        return new Response(null, { status: 204 });
      }
      if (path === `/api/tracked-items/${trackerId}`) return json(current);
      if (path === '/api/tracked-items' && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body.previewId).toBe(previewValue.id);
        current = {
          ...current,
          targetPrice: body.targetPrice,
          enabled: body.enabled,
          alerts: body.alerts,
        };
        saved = true;
        return json(current, 201);
      }
    });

    await screen.findByLabelText('Steam app URL');
    change('Steam app URL', url);
    click('Preview offer');
    expect(await screen.findByRole('heading', { name: 'Set your target' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Brotato' })).toBeVisible();
    expect(screen.getByText('$0.00')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Portal 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Half-Life 2' })).not.toBeInTheDocument();
    const previewRequest = fetch.mock.calls.find(([path]) => path === '/api/product-previews');
    expect(JSON.parse(previewRequest?.[1]?.body as string)).toEqual({ url });
    expect(fetch.mock.calls.some(([path, init]) =>
      String(path).includes('/history') || (path === '/api/tracked-items' && init?.method === 'POST'),
    )).toBe(false);

    change('Target price (USD)', '0');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
    click('Save game');
    expect(await screen.findByRole('heading', { level: 1, name: 'Brotato' })).toBeVisible();
    expect(await screen.findByText('No observations yet')).toBeVisible();
    const createRequest = fetch.mock.calls.find(([path, init]) => path === '/api/tracked-items' && init?.method === 'POST');
    expect(JSON.parse(createRequest?.[1]?.body as string)).toMatchObject({
      previewId: previewValue.id,
      targetPrice: { amountMinor: 0, currency: 'USD' },
      alerts: { email: false, push: false },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Back to watchlist' }));
    expect(await screen.findByRole('link', { name: 'Details for Brotato' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Details for Brotato' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Brotato' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Edit tracker' }));
    await screen.findByLabelText('Target price (USD)');
    change('Target price (USD)', '1.25');
    click('Save changes');
    expect(await screen.findByRole('heading', { level: 1, name: 'Brotato' })).toBeVisible();
    const patch = fetch.mock.calls.find(([path, init]) => path === `/api/tracked-items/${trackerId}` && init?.method === 'PATCH');
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({
      targetPrice: { amountMinor: 125, currency: 'USD' },
      enabled: true,
      alerts: { email: false, push: false },
    });
    click('Remove game');
    click('Remove from watchlist');
    expect(await screen.findByText('Your watchlist is empty')).toBeVisible();
    expect(fetch.mock.calls.some(([path, init]) => path === `/api/tracked-items/${trackerId}` && init?.method === 'DELETE')).toBe(true);
    expect(unexpected).toEqual([]);
  });
  it('does not substitute sample content or expose save controls when Brotato preview is unsupported', async () => {
    const url = 'https://store.steampowered.com/app/1942280/';
    const { fetch, unexpected } = open('/add', (path) =>
      path === '/api/product-previews'
        ? json({
            error: {
              ...error('UNSUPPORTED_PRODUCT').error,
              message: 'This exact app has no supported match.',
            },
          }, 422)
        : undefined,
    );
    await screen.findByLabelText('Steam app URL');
    change('Steam app URL', url);
    click('Preview offer');
    expect(await screen.findByText('This exact app has no supported match.')).toBeVisible();
    expect(screen.queryByLabelText('Target price (USD)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save game' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portal 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Half-Life 2' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([path, init]) => path === '/api/tracked-items' && init?.method === 'POST')).toBe(false);
    expect(unexpected).toEqual([]);
  });
  it('surfaces server validation fields and an owned duplicate with a useful link', async () => {
    let attempts = 0;
    const { unexpected } = open('/add', (path) => {
      if (path === '/api/tracked-items?limit=100') return json({ items: [], page });
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
                      message: 'This Steam app is not supported.',
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
    fireEvent.change(await screen.findByLabelText('Steam app URL'), { target: { value: 'https://store.steampowered.com/app/620/' } });
    click('Preview offer');
    expect(
      await screen.findByText('/url: This Steam app is not supported.'),
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
      if (path === '/api/tracked-items?limit=100') return json({ items: [], page });
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
    fireEvent.change(await screen.findByLabelText('Steam app URL'), { target: { value: 'https://store.steampowered.com/app/620/' } });
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
      await screen.findByText('Your watchlist is empty'),
    ).toBeVisible();
    const removal = fetch.mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    )!;
    expect(removal[1]?.body).toBeUndefined();
    expect(unexpected).toEqual([]);
  });
});
