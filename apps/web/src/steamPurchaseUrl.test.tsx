import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import GameDetails from './components/GameDetails';
import { steamPurchaseUrl } from './steamPurchaseUrl';
import type { SteamGame } from './types/SteamGame';

// Synthetic deal IDs stay in offline tests, never the visible catalog.
const game: SteamGame = {
  appId: 620,
  name: 'Portal 2',
  imageUrl: '',
  originalPrice: 10,
  currentPrice: 5,
  discountPercent: 50,
  currency: 'USD',
  steamOffer: {
    steamAppId: 620,
    storeId: '1',
    currency: 'USD',
    dealId: 'fixture+/=',
    observedAt: '2026-10-26',
  },
};

describe('Steam purchase navigation', () => {
  it.each(['fixture+/=', 'fixture%2B%2F%3D'])(
    'encodes a raw or encoded ID exactly once: %s',
    (dealId) => {
      const url = new URL(
        steamPurchaseUrl({
          ...game,
          steamOffer: { ...game.steamOffer!, dealId },
        })!,
      );
      expect(url.origin).toBe('https://www.cheapshark.com');
      expect(url.pathname).toBe('/redirect');
      expect(url.searchParams.get('dealID')).toBe('fixture+/=');
      expect([...url.searchParams.keys()]).toEqual(['dealID']);
    },
  );

  it.each([
    { storeId: '2' },
    { steamAppId: 400 },
    { currency: 'EUR' },
    { dealId: '' },
    { dealId: '  ' },
    { dealId: '%invalid' },
  ])('hides the action for an invalid or mismatched offer: %j', (change) => {
    const invalidGame = {
      ...game,
      steamOffer: { ...game.steamOffer!, ...change },
    };
    expect(steamPurchaseUrl(invalidGame)).toBeNull();
    render(
      <GameDetails
        game={invalidGame}
        unavailable={false}
        onClose={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(
      screen.queryByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).not.toBeInTheDocument();
  });

  it('distinguishes a missing offer from a genuine zero price', () => {
    expect(steamPurchaseUrl({ ...game, currentPrice: null })).toBeNull();
    expect(steamPurchaseUrl({ ...game, steamOffer: undefined })).toBeNull();
    expect(steamPurchaseUrl({ ...game, currency: 'EUR' })).toBeNull();
    expect(steamPurchaseUrl({ ...game, currentPrice: 0 })).not.toBeNull();
  });

  it('opens a valid purchase action safely in a new tab', () => {
    render(
      <GameDetails
        game={game}
        unavailable={false}
        onClose={() => {}}
        onEdit={() => {}}
      />,
    );
    const link = screen.getByRole('link', {
      name: 'Open Steam deal via CheapShark',
    });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
