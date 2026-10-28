import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import GameDetails from './components/GameDetails';
import { createSampleRepository } from './data/sampleRepository';
import { steamPurchaseUrl } from './steamPurchaseUrl';
import type { Product } from './data/types';

async function fixture() {
  const repository = createSampleRepository();
  const item = (await repository.list())[0]!;
  return { repository, item, product: item.product };
}
describe('Steam purchase navigation', () => {
  it.each(['fixture+/=', 'fixture%2B%2F%3D'])(
    'encodes a raw or encoded deal ID exactly once: %s',
    async (dealId) => {
      const { product } = await fixture();
      const url = new URL(steamPurchaseUrl({ ...product, dealId })!);
      expect(url.origin).toBe('https://www.cheapshark.com');
      expect(url.pathname).toBe('/redirect');
      expect(url.searchParams.get('dealID')).toBe('fixture+/=');
      expect([...url.searchParams.keys()]).toEqual(['dealID']);
    },
  );
  it.each([
    {
      identity: {
        provider: 'cheapshark',
        providerGameId: '36',
        storeId: '2',
        market: 'US',
        currency: 'USD',
      },
    },
    { steamAppId: '400' },
    { canonicalSteamUrl: 'https://store.steampowered.com.evil/app/620/' },
    { currentPrice: { amountMinor: 999, currency: 'EUR' } },
    { dealId: '' },
    { dealId: '  ' },
    { dealId: '%invalid' },
  ])('hides an invalid or mismatched offer: %j', async (change) => {
    const { item, repository } = await fixture();
    const product = { ...item.product, ...change } as Product;
    expect(steamPurchaseUrl(product)).toBeNull();
    render(
      <MemoryRouter>
        <GameDetails item={{ ...item, product }} repository={repository} />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).not.toBeInTheDocument();
  });
  it('distinguishes a missing offer from a genuine zero price', async () => {
    const { product } = await fixture();
    expect(steamPurchaseUrl({ ...product, currentPrice: null })).toBeNull();
    expect(steamPurchaseUrl({ ...product, dealId: null })).toBeNull();
    expect(
      steamPurchaseUrl({
        ...product,
        currentPrice: { amountMinor: 0, currency: 'USD' },
      }),
    ).not.toBeNull();
  });
  it('does not permit deal IDs to inject query parameters or URLs', async () => {
    const { product } = await fixture();
    const url = new URL(
      steamPurchaseUrl({
        ...product,
        dealId: 'https://evil.example/?x=1&next=bad',
      })!,
    );
    expect(url.origin).toBe('https://www.cheapshark.com');
    expect([...url.searchParams.keys()]).toEqual(['dealID']);
  });
  it('opens the dated purchase action safely in a new tab', async () => {
    const { item, repository } = await fixture();
    render(
      <MemoryRouter>
        <GameDetails item={item} repository={repository} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', {
      name: 'Open Steam deal via CheapShark',
    });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute(
      'href',
      'https://www.cheapshark.com/redirect?dealID=rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D',
    );
  });
});
