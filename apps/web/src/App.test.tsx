import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { getHealth } from './api';
import {
  createSampleRepository,
  type SampleScenario,
} from './data/sampleRepository';

function open(path = '/') {
  window.history.replaceState(null, '', path);
  return render(<App />);
}
function scenario(value: SampleScenario) {
  const tools = screen.getByText('Development tools').closest('details')!;
  tools.open = true;
  fireEvent.change(screen.getByLabelText('Sample scenario'), {
    target: { value },
  });
}
async function previewPortal() {
  fireEvent.click(screen.getByRole('button', { name: 'Use Portal 2 link' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview offer' }));
  await screen.findByLabelText('Target price (USD)');
}

describe('manual API health diagnostic preserved from the prototype', () => {
  function reveal() {
    screen.getByText('Development tools').closest('details')!.open = true;
    screen
      .getByText('API connection (manual diagnostic)')
      .closest('details')!.open = true;
  }
  it('does not fetch on landing, navigation, or diagnostic expansion', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    open();
    reveal();
    expect(screen.getByRole('status')).toHaveTextContent('Not checked yet.');
    fireEvent.click(screen.getByRole('link', { name: 'Try sample' }));
    await screen.findByRole('list', { name: 'Saved games' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('checks only the real health path on explicit request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        service: 'price-tracker-api',
        database: 'not_configured',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    open();
    reveal();
    fireEvent.click(screen.getByRole('button', { name: 'Check API' }));
    expect(await screen.findByText('API is online')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Persistence is not ready',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('reports connection failure without false success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    open();
    reveal();
    fireEvent.click(screen.getByRole('button', { name: 'Check API' }));
    expect(
      await screen.findByText(/Could not reach the API/),
    ).toBeInTheDocument();
    expect(screen.queryByText('API is online')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check API' })).toBeEnabled();
  });
  it('rejects invalid health contracts and non-success responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }),
    );
    await expect(getHealth()).rejects.toThrow('Unexpected API health response');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(getHealth()).rejects.toThrow('API is unavailable');
  });
});

describe('sample navigation, watchlist and CRUD', () => {
  it('opens on a clear sample landing and a populated watchlist', async () => {
    vi.stubGlobal('fetch', vi.fn());
    open();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Good games.Your price.',
    );
    expect(screen.getByText('Sample mode')).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: 'Try sample' }));
    const list = await screen.findByRole('list', { name: 'Saved games' });
    expect(
      within(list).getByRole('heading', { name: 'Portal 2' }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('heading', { name: 'Half-Life 2' }),
    ).toBeInTheDocument();
    expect(location.pathname).toBe('/watchlist');
    expect(
      screen.queryByRole('button', { name: /check.*(?:prices|now)/i }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('searches saved games, persists the query in the URL, and clears no results', async () => {
    open('/watchlist?q=portal');
    await screen.findByRole('list', { name: 'Saved games' });
    expect(screen.getByRole('searchbox')).toHaveValue('portal');
    expect(
      screen.queryByRole('heading', { name: 'Half-Life 2' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'not a game' },
    });
    expect(screen.getByText('No saved games match')).toBeInTheDocument();
    expect(location.search).toContain('q=not+a+game');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(
      screen.getByRole('heading', { name: 'Half-Life 2' }),
    ).toBeInTheDocument();
  });
  it('names each watchlist row’s alert channels and states accessibly', async () => {
    open('/watchlist');
    const list = await screen.findByRole('list', { name: 'Saved games' });
    const rows = within(list).getAllByRole('listitem');
    expect(
      within(rows[0]!).getByRole('group', {
        name: 'Email on, Android push off',
      }),
    ).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole('group', {
        name: 'Email on, Android push on',
      }),
    ).toBeInTheDocument();
  });
  it.each([
    ['/watchlist/tracker-portal-2', 'Portal 2'],
    ['/watchlist/tracker-portal-2/edit', 'Make it your price.'],
  ])(
    'updates the document title after %s finishes loading',
    async (path, heading) => {
      const repo = createSampleRepository();
      const original = repo.get;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(repo, 'get').mockImplementation(async (id) => {
        await pending;
        return original(id);
      });
      window.history.replaceState(null, '', path);
      render(<App repository={repo} />);
      expect(
        screen.getByRole('status', { name: 'Loading games' }),
      ).toBeInTheDocument();
      expect(document.title).toBe('Price Tracker / Price Tracker sample');
      await act(async () => {
        finish();
        await pending;
      });
      expect(
        await screen.findByRole('heading', { name: heading, level: 1 }),
      ).toBeInTheDocument();
      expect(document.title).toBe(`${heading} / Price Tracker sample`);
      fireEvent.click(screen.getByRole('link', { name: 'Account' }));
      expect(document.title).toBe('Your space. / Price Tracker sample');
    },
  );
  it('loads details from a direct URL and handles browser back navigation', async () => {
    open('/watchlist');
    await screen.findByRole('list', { name: 'Saved games' });
    fireEvent.click(screen.getByRole('link', { name: 'Details for Portal 2' }));
    expect(
      await screen.findByRole('heading', { name: 'Portal 2', level: 1 }),
    ).toBeInTheDocument();
    expect(location.pathname).toBe('/watchlist/tracker-portal-2');
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(location.pathname).toBe('/watchlist'));
    expect(
      await screen.findByRole('list', { name: 'Saved games' }),
    ).toBeInTheDocument();
  });
  it('adds only through preview and saves a zero-dollar target with per-item preferences', async () => {
    window.history.replaceState(null, '', '/add');
    const repo = createSampleRepository({ empty: true });
    render(<App repository={repo} />);
    expect(
      screen.queryByLabelText('Target price (USD)'),
    ).not.toBeInTheDocument();
    await previewPortal();
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '0.00' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Android push' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    const saved = (await repo.list())[0]!;
    expect(saved.targetPrice.amountMinor).toBe(0);
    expect(saved.alerts).toEqual({ email: false, push: true });
    expect(screen.getByText('$0.00', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/No alerts were sent/)).toBeInTheDocument();
  });
  it('rejects invalid targets without losing the offer or input', async () => {
    open('/add');
    await previewPortal();
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '-1.001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'non-negative USD target',
    );
    expect(screen.getByLabelText('Target price (USD)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('Target price (USD)')).toHaveValue('-1.001');
    expect(
      screen.getByRole('heading', { name: 'Portal 2' }),
    ).toBeInTheDocument();
  });
  it('handles duplicates without creating another tracker', async () => {
    open('/add');
    await previewPortal();
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'already in your watchlist',
    );
    fireEvent.click(
      screen.getByRole('link', { name: 'Open existing tracker' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Portal 2', level: 1 }),
    ).toBeInTheDocument();
  });
  it('edits targets/preferences without changing observed prices or history', async () => {
    const repo = createSampleRepository();
    window.history.replaceState(null, '', '/watchlist/tracker-portal-2/edit');
    render(<App repository={repo} />);
    const before = await repo.get('tracker-portal-2');
    const history = await repo.history(before.id);
    await screen.findByLabelText('Target price (USD)');
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tracking enabled' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Android push' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(/A target edit is not a price drop/),
    ).toBeInTheDocument();
    const after = await repo.get(before.id);
    expect(after.targetPrice.amountMinor).toBe(1200);
    expect(after.enabled).toBe(false);
    expect(after.product).toEqual(before.product);
    expect(await repo.history(before.id)).toEqual(history);
    expect(
      (await repo.get('tracker-half-life-2')).targetPrice.amountMinor,
    ).toBe(999);
  });
  it('cancels unsaved edits and confirms or cancels removal accessibly', async () => {
    open('/watchlist/tracker-portal-2/edit');
    const input = await screen.findByLabelText('Target price (USD)');
    fireEvent.change(input, { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    expect(screen.getByText('$4.99', { selector: 'dd' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove game' }));
    const dialog = screen.getByRole('alertdialog', {
      name: 'Remove Portal 2?',
    });
    expect(
      within(dialog).getByRole('button', { name: 'Keep game' }),
    ).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep game' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove game' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove from watchlist' }),
    );
    const list = await screen.findByRole('list', { name: 'Saved games' });
    expect(
      within(list).queryByRole('heading', { name: 'Portal 2' }),
    ).not.toBeInTheDocument();
  });
  it('keeps a failed save honest and preserves the old tracker', async () => {
    open('/watchlist/tracker-portal-2/edit');
    await screen.findByLabelText('Target price (USD)');
    scenario('save-error');
    await screen.findByLabelText('Target price (USD)');
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '22' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing changed',
    );
    expect(screen.getByLabelText('Target price (USD)')).toHaveValue('22');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    expect(screen.getByText('$4.99', { selector: 'dd' })).toBeInTheDocument();
  });
});

describe('history and useful preview states', () => {
  it('rejects a lookalike URL in the actual preview form', async () => {
    vi.stubGlobal('fetch', vi.fn());
    open('/add');
    fireEvent.change(screen.getByLabelText('Steam base-game URL'), {
      target: { value: 'https://store.steampowered.com.evil/app/620/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview offer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'store.steampowered.com /app/ URL',
    );
    expect(
      screen.queryByRole('button', { name: 'Save game' }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not let an in-flight save redirect a later screen', async () => {
    const repo = createSampleRepository({ empty: true });
    const original = repo.create;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(repo, 'create').mockImplementation(async (input) => {
      await pending;
      return original(input);
    });
    window.history.replaceState(null, '', '/add');
    render(<App repository={repo} />);
    await previewPortal();
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save game' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('link', { name: 'Account' }));
    await act(async () => {
      finish();
      await pending;
    });
    expect(location.pathname).toBe('/account');
    expect(await repo.list()).toHaveLength(1);
  });
  it.each(['success', 'failure'])(
    'does not let an unmounted removal’s %s affect a later screen',
    async (outcome) => {
      const repo = createSampleRepository();
      const original = repo.remove;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const remove = vi.spyOn(repo, 'remove').mockImplementation(async (id) => {
        await pending;
        if (outcome === 'failure') throw new Error('Deferred removal failed.');
        await original(id);
      });
      window.history.replaceState(null, '', '/watchlist');
      render(<App repository={repo} />);
      await screen.findByRole('list', { name: 'Saved games' });
      fireEvent.click(
        screen.getByRole('link', { name: 'Details for Portal 2' }),
      );
      await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Remove game' }));
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove from watchlist' }),
      );
      expect(remove).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
      await act(async () => {
        window.history.back();
      });
      await screen.findByRole('list', { name: 'Saved games' });
      fireEvent.click(screen.getByRole('link', { name: 'Account' }));
      await act(async () => {
        finish();
        await pending;
      });
      expect(location.pathname).toBe('/account');
      expect(
        screen.getByRole('heading', { name: 'Your space.', level: 1 }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(await repo.list()).toHaveLength(outcome === 'success' ? 1 : 2);
    },
  );
  it('keeps the confirmation and tracker intact after a failed removal', async () => {
    const repo = createSampleRepository();
    window.history.replaceState(null, '', '/watchlist/tracker-portal-2');
    render(<App repository={repo} />);
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    repo.setScenario('save-error');
    fireEvent.click(screen.getByRole('button', { name: 'Remove game' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove from watchlist' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing changed',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep game' }));
    repo.setScenario('normal');
    expect((await repo.get('tracker-portal-2')).product.title).toBe('Portal 2');
  });
  it('labels invented history at the chart and exposes an accessible data table', async () => {
    open('/watchlist/tracker-portal-2');
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    expect(
      screen.getByText(/These multi-day values are invented/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Illustrative sample price chart' }),
    ).toBeInTheDocument();
    screen.getByText('View chart data').closest('details')!.open = true;
    expect(screen.getByRole('table')).toHaveTextContent('2026-10-20');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      8,
    );
  });
  it.each([
    ['loading', 'Loading games'],
    ['empty', 'Make room for your next game'],
    ['offline', 'Offline preview'],
    ['expired', 'Session-expired preview'],
  ] as const)('supports %s state', async (value, text) => {
    open('/watchlist');
    await screen.findByRole('list', { name: 'Saved games' });
    scenario(value);
    if (value === 'loading')
      expect(screen.getByRole('status', { name: text })).toBeInTheDocument();
    else expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });
  it('preserves a stale successful price on check failure and does not claim a new sale', async () => {
    open('/watchlist/tracker-portal-2');
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    scenario('failed-check');
    expect(
      await screen.findByText('Last-known price preserved'),
    ).toBeInTheDocument();
    expect(screen.getByText('$9.99', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/2026-10-26 16:34:42/)).toBeInTheDocument();
  });
  it('does not turn an unknown Steam price into free or keep its purchase action', async () => {
    open('/watchlist/tracker-portal-2');
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    scenario('missing-offer');
    expect(await screen.findByText('Price unavailable')).toBeInTheDocument();
    expect(
      screen.queryByText('$0.00', { selector: 'dd' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).not.toBeInTheDocument();
    scenario('free');
    expect(
      await screen.findByText('$0.00', { selector: 'dd' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).toBeInTheDocument();
  });
  it.each([
    ['unsupported-dlc', 'DLC preview'],
    ['unsupported-bundle', 'Bundle preview'],
    ['unsupported-edition', 'Edition preview'],
    ['missing-offer', 'No eligible Steam offer'],
  ] as const)('explains %s without network requests', async (value, text) => {
    vi.stubGlobal('fetch', vi.fn());
    open('/add');
    scenario(value);
    fireEvent.click(screen.getByRole('button', { name: 'Use Portal 2 link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview offer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(
      screen.queryByRole('button', { name: 'Save game' }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('handles empty and failed history independently of retained product data', async () => {
    open('/watchlist/tracker-portal-2');
    await screen.findByRole('heading', { name: 'Portal 2', level: 1 });
    scenario('history-empty');
    expect(await screen.findByText('No observations yet')).toBeInTheDocument();
    scenario('history-error');
    expect(
      await screen.findByText(/Sample history could not load/),
    ).toBeInTheDocument();
    expect(screen.getByText('$9.99', { selector: 'dd' })).toBeInTheDocument();
  });
});

describe('honest account flow previews', () => {
  it('walks registration, resend, verification, sign-in and sign-out without transmission or storage', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    open('/register');
    expect(screen.getByLabelText('Sample email')).toHaveAttribute('readonly');
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview registration' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Check your inbox.' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview resend email' }),
    );
    expect(
      screen.getByText(/No verification email was sent/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview successful verification' }),
    );
    expect(screen.getByText(/you are not signed in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Back to sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview sign in' }));
    expect(screen.getByText(/no session was created/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Preview sign out' }));
    expect(
      screen.getByText(/There was no real session to end/),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  });
  it('prevents unverified account preview from signing in', () => {
    open('/login');
    screen.getByText('Account preview scenarios').closest('details')!.open =
      true;
    fireEvent.change(screen.getByLabelText('Account scenario'), {
      target: { value: 'unverified' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Verify your email before signing in',
    );
    expect(location.pathname).toBe('/login');
  });
  it('previews forgot/reset, rejects mismatched passwords, and does not automatically sign in', () => {
    open('/forgot');
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview reset request' }),
    );
    expect(screen.getByText(/No email was sent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Preview reset screen' }));
    fireEvent.change(screen.getByLabelText('Confirm sample password'), {
      target: { value: 'different' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview password reset' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('do not match');
    fireEvent.change(screen.getByLabelText('Confirm sample password'), {
      target: { value: 'sample-only' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview password reset' }),
    );
    expect(screen.getByText(/No password was saved/)).toBeInTheDocument();
    expect(location.pathname).toBe('/reset');
  });
  it.each(['/verify', '/reset'])(
    'supports expired-link preview on %s',
    (path) => {
      open(path);
      screen.getByText('Account preview scenarios').closest('details')!.open =
        true;
      fireEvent.change(screen.getByLabelText('Account scenario'), {
        target: { value: 'expired' },
      });
      fireEvent.click(
        screen.getByRole('button', {
          name:
            path === '/verify'
              ? 'Preview successful verification'
              : 'Preview password reset',
        }),
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Expired-link preview',
      );
    },
  );
});
