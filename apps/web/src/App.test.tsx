import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { getHealth } from './api';

describe('starter connection check', () => {
  it('makes the unimplemented scope clear and does not fetch on load', () => {
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

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

    fireEvent.click(screen.getByRole('button', { name: 'Check API' }));

    expect(await screen.findByText('API is online')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Persistence is not ready');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports a failed API connection without showing success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Check API' }));

    expect(await screen.findByText(/Could not reach the API/)).toBeInTheDocument();
    expect(screen.queryByText('API is online')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check API' })).toBeEnabled();
  });

  it('rejects invalid health contracts and non-success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    }));

    await expect(getHealth()).rejects.toThrow('Unexpected API health response');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(getHealth()).rejects.toThrow('API is unavailable');
  });
});
