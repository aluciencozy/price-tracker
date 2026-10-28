import { RepositoryError, type Money, type TrackedItem } from './types';

export function assertMoney(value: Money) {
  if (
    value.currency !== 'USD' ||
    !Number.isSafeInteger(value.amountMinor) ||
    value.amountMinor < 0
  )
    throw new RepositoryError(
      'validation',
      'Use a non-negative, whole number of USD cents.',
    );
}
export function parseTarget(value: string): Money {
  const input = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(input))
    throw new RepositoryError(
      'validation',
      'Enter a non-negative USD target with at most two decimal places.',
    );
  const [dollars, fraction = ''] = input.split('.');
  const result: Money = {
    amountMinor: Number(dollars) * 100 + Number(fraction.padEnd(2, '0')),
    currency: 'USD',
  };
  assertMoney(result);
  return result;
}
export function parseSteamUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new RepositoryError(
      'validation',
      'Paste a full HTTPS Steam base-game /app/ URL.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'store.steampowered.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RepositoryError(
      'validation',
      'Use an HTTPS store.steampowered.com /app/ URL without credentials, query parameters, or fragments.',
    );
  if (/^\/(bundle|sub)\//.test(url.pathname))
    throw new RepositoryError(
      'unsupported',
      'Bundles and subscriptions are not supported. Use an individual base-game /app/ URL.',
    );
  const match = url.pathname.match(/^\/app\/([1-9]\d{0,31})(?:\/[^/]+)?\/?$/);
  if (!match)
    throw new RepositoryError(
      'validation',
      'Paste a full HTTPS Steam base-game /app/ URL.',
    );
  return match[1]!;
}
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});
export function formatMoney(value: Money | null) {
  return value === null
    ? 'Price unavailable'
    : usd.format(value.amountMinor / 100);
}
export function trackerStatus(item: TrackedItem) {
  if (!item.enabled) return 'Paused';
  if (!item.product.currentPrice) return 'Steam offer missing';
  return item.product.currentPrice.amountMinor <= item.targetPrice.amountMinor
    ? 'At your target (sample)'
    : 'Above your target (sample)';
}
