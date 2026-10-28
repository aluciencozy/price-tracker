import { useState } from 'react';
import Header from './components/Header';
import Home from './components/Home';
import type { SteamGame } from './types/SteamGame';
import GameCard from './components/GameCard';
import GameDetails from './components/GameDetails';
import Watchlist from './components/Watchlist';

import type { Page, UiState } from './types/Navigation';
import AuthScreen from './components/AuthScreen';
import ConnectionCheck from './components/ConnectionCheck';
import TrackerForm from './components/TrackerForm';
import { Btn, Panel, Status } from './components/Ui';

// Example data, not live Steam prices. Portal 2 / Half-Life 2 offers are
// dated snapshots from docs/cheapshark-proof.json; their purchase links may expire.
const sampleGames: SteamGame[] = [
  {
    appId: 620,
    name: 'Portal 2',
    imageUrl: '',
    originalPrice: 9.99,
    currentPrice: 9.99,
    discountPercent: 0,
    currency: 'USD',
    steamOffer: {
      steamAppId: 620,
      storeId: '1',
      currency: 'USD',
      dealId: 'rwQ2JCEr5NOySyBsAj6fyPuZg4qMlh9w67U%2BmM6b2VE%3D',
      observedAt: '2026-10-26',
    },
  },
  {
    appId: 400,
    name: 'Portal',
    imageUrl: '',
    originalPrice: 10,
    currentPrice: 10,
    discountPercent: 0,
    currency: 'USD',
  },
  {
    appId: 220,
    name: 'Half-Life 2',
    imageUrl: '',
    originalPrice: 9.99,
    currentPrice: 9.99,
    discountPercent: 0,
    currency: 'USD',
    steamOffer: {
      steamAppId: 220,
      storeId: '1',
      currency: 'USD',
      dealId: 'Vz5eZMF1sKvs02I4cuEgrGnmM1r%2BkWHig0YMa0lJ0vM%3D',
      observedAt: '2026-10-26',
    },
  },
  {
    appId: 367520,
    name: 'Hollow Knight',
    imageUrl: '',
    originalPrice: 15,
    currentPrice: 9,
    discountPercent: 40,
    currency: 'USD',
  },
  {
    appId: 413150,
    name: 'Stardew Valley',
    imageUrl: '',
    originalPrice: 15,
    // Missing-offer UI fixture, not a claim about this game's actual availability.
    currentPrice: null,
    discountPercent: 0,
    currency: 'USD',
  },
  {
    appId: 1145360,
    name: 'Hades',
    imageUrl: '',
    originalPrice: 25,
    currentPrice: 15,
    discountPercent: 40,
    currency: 'USD',
  },
];

export default function App() {
  // Keep preview selections here so changing pages preserves them until refresh.
  const [page, setPage] = useState<Page>('home');
  // These states let the team review edge cases without making API requests.
  const [demoState, setDemoState] = useState<UiState>('normal');
  const [trackedIds, setTrackedIds] = useState<number[]>([]);
  const [targets, setTargets] = useState<Record<number, number>>({});
  const [query, setQuery] = useState('');
  const [selectedGame, setSelectedGame] = useState<SteamGame | null>(null);
  const [editingGame, setEditingGame] = useState<SteamGame | null>(null);
  const [inApp, setInApp] = useState(true);
  const [emailAlert, setEmailAlert] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);

  function toggleGame(appId: number): void {
    setTrackedIds((previousIds) =>
      previousIds.includes(appId)
        ? previousIds.filter((id) => id !== appId)
        : [...previousIds, appId],
    );
  }

  function searchGame(input: string) {
    setQuery(input);
  }
  const filteredGames = sampleGames.filter((game) =>
    game.name.toLowerCase().includes(query.toLowerCase()),
  );
  const trackedGames = filteredGames.filter((game) =>
    trackedIds.includes(game.appId),
  );

  function openGameDetails(game: SteamGame) {
    setSelectedGame(game);
    setPage('details');
  }
  function closeGameDetails() {
    setSelectedGame(null);
    setPage('watchlist');
  }
  function addGame() {
    setEditingGame(null);
    setPage('tracker');
  }
  function editGame(game: SteamGame) {
    setEditingGame(game);
    setPage('tracker');
  }
  const auth = ['login', 'register', 'verify', 'forgot', 'reset'].includes(
    page,
  );

  return (
    <div className="min-h-screen text-slate-300">
      <Header page={page} navigate={setPage} onAdd={addGame} />
      <div className="border-b border-amber-800 bg-amber-950/40 px-4 py-2 text-center text-sm text-amber-200">
        Mock UI for review. Example prices are not live. Selections last only
        until you refresh. Accounts, saved watchlists, price history, and alerts
        are not implemented yet.
      </div>
      {page === 'home' ? (
        <Home navigate={setPage} onAdd={addGame} />
      ) : auth ? (
        <AuthScreen key={page} page={page} navigate={setPage} />
      ) : (
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold">
                {page === 'watchlist'
                  ? 'Your watchlist'
                  : page === 'tracker'
                    ? editingGame
                      ? 'Edit tracker'
                      : 'Add tracker'
                    : page === 'details'
                      ? 'Game details & history'
                      : 'Notification preferences'}
              </h1>
              <p className="mt-1 text-slate-400">
                PC base games only · Steam offers · USD
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              Developer preview state
              <select
                value={demoState}
                onChange={(event) =>
                  setDemoState(event.target.value as UiState)
                }
                className="rounded-lg border border-slate-600 bg-slate-900/80 px-2 py-2"
              >
                {(
                  [
                    'normal',
                    'loading',
                    'empty',
                    'validation',
                    'expired',
                    'unavailable',
                    'unsupported',
                    'unsupported-dlc',
                    'unsupported-bundle',
                    'unsupported-edition',
                  ] as const
                ).map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
            </label>
          </div>
          {demoState === 'expired' && (
            <Status tone="error">
              Session-expired preview.{' '}
              <button className="underline" onClick={() => setPage('login')}>
                Sign in again
              </button>
              .
            </Status>
          )}
          {demoState === 'validation' && (
            <Status tone="error">
              Validation example: enter a non-negative USD target; confirmation
              passwords must match.
            </Status>
          )}
          {demoState === 'unsupported' && (
            <Status tone="error">
              Unsupported link preview: DLC, bundles, and special editions are
              outside MVP scope.
            </Status>
          )}
          {demoState === 'unsupported-dlc' && (
            <Status tone="error">
              DLC preview: this item is additional content, not a base game. Add
              the base game instead. Actual app-type validation requires the
              API.
            </Status>
          )}
          {demoState === 'unsupported-bundle' && (
            <Status tone="error">
              Bundle preview: bundles are not supported. Use an individual Steam
              base-game /app/ link.
            </Status>
          )}
          {demoState === 'unsupported-edition' && (
            <Status tone="error">
              Edition preview: the exact base-game edition could not be
              verified. This item cannot be tracked; do not substitute another
              edition.
            </Status>
          )}
          {demoState === 'unavailable' && (
            <p className="rounded-lg border border-teal-800 bg-teal-950/50 p-3 text-sm text-teal-200">
              Unavailable-price preview: no eligible Steam offer. Purchase
              unavailable.
            </p>
          )}

          {page === 'watchlist' && (
            <>
              <Watchlist
                games={trackedGames}
                onRemove={toggleGame}
                onViewDetails={openGameDetails}
                onEdit={editGame}
                onAdd={addGame}
                targets={targets}
                query={query}
                onSearch={searchGame}
                previewState={demoState}
              />
              <Panel title="Browse games">
                <p className="mb-4 text-sm text-slate-400">
                  Example games and prices · selections are not saved. Use the
                  watchlist search to filter this catalog too.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {filteredGames.map((game) => (
                    <GameCard
                      key={game.appId}
                      game={game}
                      isTracked={trackedIds.includes(game.appId)}
                      onToggleTrack={toggleGame}
                      onViewDetails={openGameDetails}
                      unavailable={demoState === 'unavailable'}
                    />
                  ))}
                </div>
                {filteredGames.length === 0 && (
                  <p className="mt-4 text-sm text-slate-400">
                    No example games match “{query}”. Try another name.
                  </p>
                )}
              </Panel>
            </>
          )}
          {page === 'tracker' && (
            <TrackerForm
              key={editingGame?.appId ?? 'new'}
              game={editingGame}
              targetMinor={editingGame ? targets[editingGame.appId] : undefined}
              games={sampleGames}
              onCancel={() => setPage('watchlist')}
              onSave={(appId, cents) => {
                setTargets((previous) => ({ ...previous, [appId]: cents }));
                setTrackedIds((previous) =>
                  previous.includes(appId) ? previous : [...previous, appId],
                );
                setPage('watchlist');
              }}
            />
          )}
          {page === 'details' && selectedGame && (
            <GameDetails
              game={selectedGame}
              onClose={closeGameDetails}
              onEdit={() => editGame(selectedGame)}
              targetMinor={targets[selectedGame.appId]}
              unavailable={demoState === 'unavailable'}
            />
          )}
          {page === 'notifications' && (
            <Panel title="Notification preferences">
              <div className="max-w-xl space-y-5">
                <p className="text-sm text-slate-400">
                  Preview preferences only. No notifications are delivered.
                </p>
                <label className="flex items-center justify-between gap-4">
                  In-app notifications
                  <input
                    type="checkbox"
                    checked={inApp}
                    onChange={(event) => {
                      setInApp(event.target.checked);
                      setPrefsSaved(false);
                    }}
                    className="h-5 w-5"
                  />
                </label>
                <label className="flex items-center justify-between gap-4">
                  Email notifications (mock preference)
                  <input
                    type="checkbox"
                    checked={emailAlert}
                    onChange={(event) => {
                      setEmailAlert(event.target.checked);
                      setPrefsSaved(false);
                    }}
                    className="h-5 w-5"
                  />
                </label>
                <Btn onClick={() => setPrefsSaved(true)}>
                  Save preferences (mock)
                </Btn>
                {prefsSaved && (
                  <Status tone="success">
                    Preferences updated in local React state only; no server
                    save or email delivery occurred.
                  </Status>
                )}
              </div>
            </Panel>
          )}
        </main>
      )}
      <div className="mx-auto max-w-6xl px-4 pt-6">
        <details className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
          <summary className="cursor-pointer font-semibold">
            Development tools · API connection
          </summary>
          <div className="mt-4">
            <ConnectionCheck />
          </div>
        </details>
      </div>
      <footer className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-400">
        Price Tracker · PC base games · USD · Planned price data source:{' '}
        <a
          className="underline"
          href="https://www.cheapshark.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          CheapShark
        </a>
      </footer>
    </div>
  );
}
