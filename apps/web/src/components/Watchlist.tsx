import type { SteamGame } from '../types/SteamGame';
import type { UiState } from '../types/Navigation';
import GameSearch from './GameSearch';
import { Btn, LoadingRows } from './Ui';

type WatchlistProps = {
  games: SteamGame[];
  onRemove: (appId: number) => void;
  onViewDetails: (game: SteamGame) => void;
  onEdit: (game: SteamGame) => void;
  onAdd: () => void;
  targets: Record<number, number>;
  query: string;
  onSearch: (input: string) => void;
  previewState: UiState;
};

export default function Watchlist({
  games,
  onRemove,
  onViewDetails,
  onEdit,
  onAdd,
  targets,
  query,
  onSearch,
  previewState,
}: WatchlistProps) {
  return (
    <section
      className="rounded-xl border border-slate-700 bg-slate-900/80 p-4 shadow-sm sm:p-6"
      aria-labelledby="watchlist-title"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="watchlist-title" className="text-xl font-bold text-white">
          My Watchlist
        </h2>
        <span className="text-sm text-slate-400">
          {games.length} {games.length === 1 ? 'game' : 'games'} shown
        </span>
      </div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full max-w-sm">
          <GameSearch query={query} onSearch={onSearch} />
        </div>
        <Btn onClick={onAdd}>+ Add tracker</Btn>
      </div>
      {previewState === 'loading' ? (
        <LoadingRows />
      ) : games.length === 0 || previewState === 'empty' ? (
        <div className="rounded-lg border border-dashed border-slate-600 p-8 text-center text-slate-400">
          <p className="mb-3">
            {query
              ? 'No tracked games match your search.'
              : "You aren't tracking any games yet."}
          </p>
          <Btn onClick={onAdd}>Add your first tracker</Btn>
          <p className="mt-3 text-sm">
            Or choose Track Game from the example catalog below.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <caption className="sr-only">
              Selected example games and sample USD prices
            </caption>
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                {[
                  'Steam game',
                  'Current offer',
                  'Target',
                  'Status',
                  'Actions',
                ].map((label) => (
                  <th key={label} scope="col" className="p-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {games.map((game) => (
                <tr key={game.appId} className="border-b border-slate-700">
                  <th scope="row" className="p-3 font-semibold">
                    {game.name}
                    <div className="text-xs font-normal text-slate-400">
                      App {game.appId} · Example base game
                    </div>
                  </th>
                  <td className="p-3">
                    {previewState === 'unavailable' ||
                    game.currentPrice === null
                      ? 'Price unavailable'
                      : `$${game.currentPrice.toFixed(2)}`}
                  </td>
                  <td className="p-3">
                    {targets[game.appId] === undefined
                      ? 'Not set'
                      : `$${((targets[game.appId] ?? 0) / 100).toFixed(2)}`}
                  </td>
                  <td className="p-3">
                    {previewState === 'unavailable' ||
                    game.currentPrice === null
                      ? 'Steam offer missing'
                      : targets[game.appId] === undefined
                        ? 'Set a target'
                        : Math.round(game.currentPrice * 100) <=
                            (targets[game.appId] ?? 0)
                          ? 'Target reached (sample)'
                          : 'Waiting for drop (sample)'}
                  </td>
                  <td className="p-3">
                    <div className="flex gap-3">
                      <button
                        className="text-teal-300 underline"
                        aria-label={`Details for ${game.name}`}
                        onClick={() => onViewDetails(game)}
                      >
                        Details
                      </button>
                      <button
                        className="text-teal-300 underline"
                        aria-label={`Edit ${game.name}`}
                        onClick={() => onEdit(game)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-rose-300 underline"
                        aria-label={`Remove ${game.name} from watchlist`}
                        onClick={() => onRemove(game.appId)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-400">
        Session preview · example prices are not live; selections and targets
        are not saved.
      </p>
    </section>
  );
}
