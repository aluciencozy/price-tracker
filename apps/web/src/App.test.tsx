import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { getHealth } from './api';

describe('starter connection check', () => {
  it('makes the unimplemented scope clear and does not fetch on load', () => {
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByText('Development tools · API connection'));

    expect(screen.getByText(/not implemented yet/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not checked yet.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the real health path and displays missing database readiness', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        service: 'price-tracker-api',
        database: 'not_configured',
      }),
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByText('Development tools · API connection'));

    fireEvent.click(screen.getByRole('button', { name: 'Check API' }));

    expect(await screen.findByText('API is online')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Persistence is not ready',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports a failed API connection without showing success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(<App />);
    fireEvent.click(screen.getByText('Development tools · API connection'));

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
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok' }),
      }),
    );

    await expect(getHealth()).rejects.toThrow('Unexpected API health response');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(getHealth()).rejects.toThrow('API is unavailable');
  });
});

describe('prototype layout integration', () => {
  it('opens on home and connects its actions without losing watchlist state', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Price Tracker',
    );
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try a tracker' }));
    expect(
      screen.getByLabelText('Steam base-game URL or app ID'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Price Tracker home' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Explore the watchlist' }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Track Game' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Explore the watchlist' }),
    );
    expect(screen.getByRole('table')).toHaveTextContent('Portal 2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps tracking, search, details, and removal working across screens', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Track Game' })[0]!);
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'Portal 2' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Portal 2' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Game details & history' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Current Discount: 0%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to watchlist' }));
    expect(screen.getByRole('searchbox')).toHaveValue('Portal 2');
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Portal 2 from watchlist' }),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds a zero-dollar target and preserves edited targets through navigation', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Add tracker' }));
    fireEvent.change(screen.getByLabelText('Steam base-game URL or app ID'), {
      target: { value: 'https://store.steampowered.com/app/620/' },
    });
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '0' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save tracker (mock)' }),
    );
    expect(screen.getByRole('table')).toHaveTextContent('$0.00');
    expect(screen.getByRole('table')).toHaveTextContent(
      'Waiting for drop (sample)',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit Portal 2' }));
    expect(screen.getByLabelText('Target price (USD)')).toHaveValue(0);
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '12' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save tracker (mock)' }),
    );
    expect(screen.getByRole('table')).toHaveTextContent(
      'Target reached (sample)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Email notifications (mock preference)',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save preferences (mock)' }),
    );
    expect(
      screen.getByText(/Preferences updated in local React state only/),
    ).toHaveAttribute('role', 'status');
    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
    expect(screen.getByRole('table')).toHaveTextContent('$12.00');
  });

  it('rejects lookalike Steam hosts and hides sample quotes in unavailable preview', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Add tracker' }));
    fireEvent.change(screen.getByLabelText('Steam base-game URL or app ID'), {
      target: { value: 'https://evil.example/store.steampowered.com/app/620/' },
    });
    fireEvent.change(screen.getByLabelText('Target price (USD)'), {
      target: { value: '5' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save tracker (mock)' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use a sample Steam base-game URL',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Track Game' })[0]!);
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'unavailable' },
    });
    expect(screen.getByRole('table')).toHaveTextContent('Price unavailable');
    expect(screen.getByRole('table')).not.toHaveTextContent('$9.99');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Portal 2' }),
    );
    expect(
      screen.getByText('Steam offer unavailable. Purchase unavailable.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Steam examples and unsupported previews', () => {
  it.each([
    ['unsupported-dlc', 'this item is additional content, not a base game'],
    ['unsupported-bundle', 'Use an individual Steam base-game /app/ link'],
    [
      'unsupported-edition',
      'the exact base-game edition could not be verified',
    ],
  ])(
    'shows the %s explanation without requesting a provider',
    (state, message) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: state },
      });
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(
        screen.queryByRole('button', { name: /check.*(?:now|prices)/i }),
      ).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('routes a recorded Steam deal through CheapShark without fetching it', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
    fireEvent.click(
      screen.getAllByRole('button', { name: 'View Details' })[0]!,
    );
    expect(screen.getByText('$9.99 USD')).toBeInTheDocument();
    expect(
      screen.getByText(/Recorded Steam offer from 2026-10-26/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).toHaveAttribute(
      'href',
      'https://www.cheapshark.com/redirect?dealID=rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D',
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'unavailable' },
    });
    expect(
      screen.queryByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a missing Steam offer unavailable across the watchlist and details', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Watchlist' }));
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'Stardew Valley' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Track Game' }));
    expect(screen.getByRole('table')).toHaveTextContent('Price unavailable');
    expect(screen.getByRole('table')).toHaveTextContent('Steam offer missing');
    expect(screen.getByRole('table')).not.toHaveTextContent('$0.00');
    fireEvent.click(
      screen.getByRole('button', { name: 'Details for Stardew Valley' }),
    );
    expect(
      screen.getByText('Steam offer unavailable. Purchase unavailable.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open Steam deal via CheapShark' }),
    ).not.toBeInTheDocument();
  });
});
