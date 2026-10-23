export type Health = {
  status: 'ok';
  service: 'price-tracker-api';
  database:
    | 'not_configured'
    | 'connecting'
    | 'connected'
    | 'disconnected';
};

export async function getHealth(): Promise<Health> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

  const response = await fetch(`${base}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error('API is unavailable. Start the API and try again.');
  }

  const data: unknown = await response.json();

  // A successful HTTP response may still be a proxy page or an unexpected payload.
  if (
    typeof data !== 'object'
    || data === null
    || !('status' in data)
    || data.status !== 'ok'
    || !('service' in data)
    || data.service !== 'price-tracker-api'
    || !('database' in data)
    || typeof data.database !== 'string'
    || !['not_configured', 'connecting', 'connected', 'disconnected'].includes(data.database)
  ) {
    throw new Error('Unexpected API health response.');
  }

  return data as Health;
}
