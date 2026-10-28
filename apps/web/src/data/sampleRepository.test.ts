import { describe, expect, it, vi } from 'vitest';
import { createSampleRepository } from './sampleRepository';
import { formatMoney, parseSteamUrl, parseTarget } from './validation';
import type { Preferences } from './types';

const prefs: Preferences = {
  targetPrice: { amountMinor: 0, currency: 'USD' },
  enabled: true,
  alerts: { email: false, push: true },
};
describe('money and Steam URL validation', () => {
  it.each([
    ['0', 0],
    ['0.00', 0],
    ['9.99', 999],
    ['12.3', 1230],
    [' 1.01 ', 101],
  ])('parses %s as exact integer cents', (value, cents) =>
    expect(parseTarget(value)).toEqual({ amountMinor: cents, currency: 'USD' }),
  );
  it.each([
    '',
    '-1',
    '1.001',
    'Infinity',
    '1e2',
    '9007199254740992',
    'NaN',
    '.99',
  ])('rejects invalid target %s', (value) =>
    expect(() => parseTarget(value)).toThrow(),
  );
  it('formats zero separately from unknown', () => {
    expect(formatMoney(null)).toBe('Price unavailable');
    expect(formatMoney(prefs.targetPrice)).toBe('$0.00');
  });
  it.each([
    'http://store.steampowered.com/app/620/',
    'https://store.steampowered.com.evil/app/620/',
    'https://evil.example/store.steampowered.com/app/620/',
    'https://user:pass@store.steampowered.com/app/620/',
    'https://store.steampowered.com:444/app/620/',
    'https://store.steampowered.com/app/620/?x=y',
    'https://store.steampowered.com/bundle/1/',
    'https://store.steampowered.com/sub/1/',
    '620',
  ])('rejects unsafe or unsupported URL %s', (url) =>
    expect(() => parseSteamUrl(url)).toThrow(),
  );
  it('parses a canonical URL or title slug without fetching', () => {
    expect(parseSteamUrl('https://store.steampowered.com/app/620/')).toBe(
      '620',
    );
    expect(
      parseSteamUrl('https://store.steampowered.com/app/220/Half_Life_2/'),
    ).toBe('220');
  });
});
describe('injectable async sample repository', () => {
  it('has distinct tracker, product, provider, app and deal identities', async () => {
    const [item] = await createSampleRepository().list();
    expect(item!.product.identity).toEqual({
      provider: 'cheapshark',
      providerGameId: '36',
      storeId: '1',
      market: 'US',
      currency: 'USD',
    });
    expect(
      new Set([
        item!.id,
        item!.product.id,
        item!.product.steamAppId,
        item!.product.identity.providerGameId,
        item!.product.dealId,
      ]).size,
    ).toBe(5);
  });
  it('previews then creates zero targets, searches, edits per-item prefs and removes', async () => {
    const repo = createSampleRepository({ empty: true });
    const first = await repo.preview('https://store.steampowered.com/app/620/');
    const item = await repo.create({ previewId: first.id, ...prefs });
    const other = await repo.create({
      previewId: (await repo.preview('https://store.steampowered.com/app/220/'))
        .id,
      ...prefs,
    });
    expect((await repo.list('PORTAL')).map((item) => item.id)).toEqual([
      item.id,
    ]);
    const before = await repo.history(item.id);
    const changed = await repo.update(item.id, {
      ...prefs,
      enabled: false,
      alerts: { email: true, push: false },
      targetPrice: { amountMinor: 1500, currency: 'USD' },
    });
    expect(changed.enabled).toBe(false);
    expect(changed.product).toEqual(item.product);
    expect(await repo.history(item.id)).toEqual(before);
    expect((await repo.get(other.id)).alerts).toEqual(prefs.alerts);
    await repo.remove(item.id);
    await expect(repo.get(item.id)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
  it('does not permit missing previews, duplicate saves or unsupported catalog bypasses', async () => {
    const repo = createSampleRepository();
    await expect(
      repo.create({ previewId: 'invented', ...prefs }),
    ).rejects.toMatchObject({ code: 'preview-expired' });
    const preview = await repo.preview(
      'https://store.steampowered.com/app/620/',
    );
    await expect(
      repo.create({ previewId: preview.id, ...prefs }),
    ).rejects.toMatchObject({
      code: 'duplicate',
      resourceId: 'tracker-portal-2',
    });
    await expect(
      repo.preview('https://store.steampowered.com/app/999/'),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(await repo.list()).toHaveLength(2);
  });
  it('expires a sample preview without changing its product or creating a tracker', async () => {
    const repo = createSampleRepository({ empty: true });
    const preview = await repo.preview(
      'https://store.steampowered.com/app/620/',
    );
    const time = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(preview.expiresAt));
    try {
      await expect(
        repo.create({ previewId: preview.id, ...prefs }),
      ).rejects.toMatchObject({ code: 'preview-expired' });
    } finally {
      time.mockRestore();
    }
    expect(await repo.list()).toHaveLength(0);
  });
  it('returns copies, and each instance resets independently', async () => {
    const repo = createSampleRepository();
    const [item] = await repo.list();
    item!.product.title = 'changed';
    item!.alerts.email = false;
    expect((await repo.get(item!.id)).product.title).toBe('Portal 2');
    await repo.remove(item!.id);
    expect(await createSampleRepository().list()).toHaveLength(2);
  });
  it('preserves last-success data and history on a failed check; never writes zero', async () => {
    const repo = createSampleRepository();
    const before = await repo.get('tracker-portal-2');
    const history = await repo.history(before.id);
    repo.setScenario('failed-check');
    const after = await repo.get(before.id);
    expect(after.product.currentPrice).toEqual(before.product.currentPrice);
    expect(after.product.observedAt).toBe(before.product.observedAt);
    expect(after.product.lastError).not.toBeNull();
    expect(await repo.history(before.id)).toEqual(history);
  });
  it.each([
    'unsupported-dlc',
    'unsupported-bundle',
    'unsupported-edition',
    'missing-offer',
  ] as const)('rejects %s with no provider requests', async (scenario) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const repo = createSampleRepository();
    repo.setScenario(scenario);
    await expect(
      repo.preview('https://store.steampowered.com/app/620/'),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps changes intact after failed mutations and expired/offline views', async () => {
    const repo = createSampleRepository();
    const before = await repo.get('tracker-portal-2');
    repo.setScenario('save-error');
    await expect(repo.update(before.id, prefs)).rejects.toMatchObject({
      code: 'save-error',
    });
    await expect(repo.remove(before.id)).rejects.toThrow();
    repo.setScenario('expired');
    await expect(repo.list()).rejects.toMatchObject({ code: 'expired' });
    repo.setScenario('offline');
    await expect(repo.list()).rejects.toMatchObject({ code: 'offline' });
    repo.setScenario('normal');
    expect(await repo.get(before.id)).toEqual(before);
  });
});
