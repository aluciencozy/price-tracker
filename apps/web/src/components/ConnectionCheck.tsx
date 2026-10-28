import { useState } from 'react';
import { getHealth, type Health } from '../api';

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
    <section
      className="rounded-2xl border border-slate-700 bg-slate-900/80 p-6 sm:p-8"
      aria-labelledby="connection"
    >
      <div className="flex flex-col items-start justify-between gap-6 sm:flex-row">
        <div>
          <h2 id="connection" className="text-xl font-semibold text-white">
            Check the connection
          </h2>

          <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-300">
            Confirm the shared Express API is reachable. No database or service
            credentials are needed for this check.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void checkConnection()}
          disabled={busy}
          className="shrink-0 rounded-lg bg-teal-300 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-teal-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Checking…' : 'Check API'}
        </button>
      </div>

      <div
        className="mt-6 rounded-lg bg-slate-950 p-4 text-sm text-slate-300"
        role="status"
        aria-live="polite"
      >
        {error ? (
          <span className="text-rose-300">{error}</span>
        ) : health ? (
          <>
            <p className="font-semibold text-teal-300">API is online</p>

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
