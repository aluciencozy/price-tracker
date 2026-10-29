import { useState } from 'react';
import { getHealth, type Health } from '../api';
import { Button } from './ui/button';

export default function ConnectionCheck() {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function checkConnection() {
    // Clear the previous result while this request is in progress.
    setBusy(true);
    setError('');
    setHealth(null);

    try {
      setHealth(await getHealth());
    } catch {
      setError('Could not reach the API. Start the API and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="connection-check" aria-labelledby="connection">
      <div className="flex flex-col items-start justify-between gap-6 sm:flex-row">
        <div>
          <h2 id="connection">Check the connection</h2>

          <p className="muted-copy mt-2">
            Confirm the shared Express API is reachable. No database or service
            credentials are needed for this check.
          </p>
        </div>

        <Button
          type="button"
          onClick={() => void checkConnection()}
          disabled={busy}
        >
          {busy ? 'Checking…' : 'Check API'}
        </Button>
      </div>

      <div className="connection-result" role="status" aria-live="polite">
        {error ? (
          <span>{error}</span>
        ) : health ? (
          <>
            <p>API is online</p>

            <p className="mt-1">
              Database: {health.database.replaceAll('_', ' ')}.{' '}
              {health.database !== 'connected' && 'Persistence is not ready.'}
            </p>
          </>
        ) : busy ? (
          'Contacting the API…'
        ) : (
          'Not checked yet.'
        )}
      </div>
    </section>
  );
}
