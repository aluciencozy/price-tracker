import { useState } from 'react';
import { getHealth, type Health } from './api';
import Header from './components/Header';
import type { SteamGame } from "./types/SteamGame";
import GameCard from "./components/GameCard";
import GameSearch from './components/GameSearch';
import GameDetails from './components/GameDetails';
import Watchlist from './components/Watchlist';

// Example data, not live Steam prices
const sampleGames: SteamGame[] = [
  {
    appId: 620,
    name: "Portal 2",
    imageUrl: "",
    originalPrice: 20,
    currentPrice: 10,
    discountPercent: 50,
    currency: "USD",
  },
  {
    appId: 400,
    name: "Portal",
    imageUrl: "",
    originalPrice: 10,
    currentPrice: 10,
    discountPercent: 0,
    currency: "USD",
  },
];

export default function App() {
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

  // Toggles whether the game is on the watchlist
  const [trackedIds, setTrackedIds] = useState<number[]>([]);

  function toggleGame(appID: number): void {

    setTrackedIds(previousIds => {

      if (previousIds.includes(appID)) {
        return previousIds.filter(id => id !== appID);
      }

      return [...previousIds, appID];
    });
  }

  // For Searching Games
  const [query, setQuery] = useState<string>("");

  function searchGame(input: string) {
    setQuery(input)
  }

  const filteredGames = sampleGames.filter(game =>
    game.name.toLowerCase().includes(query.toLowerCase())
  )

  // Used to show the trackedGames in WatchList
  const trackedGames = sampleGames.filter(game =>
    trackedIds.includes(game.appId)
  );

  // For Selected and Deselected Game Details
  const [selectedGame, setSelectedGame] = useState<SteamGame | null>(null);

  function openGameDetails(game: SteamGame): void {
    setSelectedGame(game);
  }

  function closeGameDetails(): void {
    setSelectedGame(null)
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-10 sm:px-10 sm:py-16">

      <Header />

      <GameSearch query={query} onSearch={searchGame} />

      {filteredGames.map(game => (
        <GameCard
          key={game.appId}
          game={game}
          isTracked={trackedIds.includes(game.appId)}
          onToggleTrack={toggleGame}
          onViewDetails={openGameDetails}
        />
      ))}



      <Watchlist games={trackedGames} onRemove={toggleGame} />

      {selectedGame && (
        <GameDetails game={selectedGame} onClose={closeGameDetails} />
      )}

      <section className="max-w-2xl py-16 sm:py-24" aria-labelledby="intro">
        <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-teal-300">
          One API. Web + Android.
        </p>

        <h1
          id="intro"
          className="text-4xl font-semibold leading-tight tracking-tight text-white sm:text-6xl"
        >
          A starting point for<br />smarter price tracking.
        </h1>

        <p className="mt-6 text-lg leading-relaxed text-slate-300">
          The project foundation is ready. Accounts, tracked products, price history,
          and alerts are not implemented yet.
        </p>
      </section>

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

      <footer className="mt-auto pt-12 text-xs leading-relaxed text-slate-400">
        Price Tracker · COP 4331C · No live retailer data or saved watchlists in this starter.
      </footer>
    </main>
  );
}
