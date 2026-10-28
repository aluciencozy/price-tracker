import type { SteamGame } from '../types/SteamGame';

type GameCardProps = {
  game: SteamGame;
  isTracked: boolean;
  onToggleTrack: (appId: number) => void;
  unavailable: boolean;
  onViewDetails: (game: SteamGame) => void;
};

function GameCard({
  game,
  isTracked,
  onToggleTrack,
  onViewDetails,
  unavailable,
}: GameCardProps) {
  const missingOffer = unavailable || game.currentPrice === null;
  return (
    <article className="rounded-2xl border border-slate-700 bg-slate-900/80 p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-teal-300">
          Steam · Example
        </span>
        <span className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium text-slate-300">
          {missingOffer
            ? 'Offer missing'
            : game.discountPercent > 0
              ? `${game.discountPercent}% off`
              : 'Regular price'}
        </span>
      </div>
      <h3 className="text-xl font-semibold text-white">{game.name}</h3>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-white">
        {missingOffer
          ? 'Price unavailable'
          : `$${game.currentPrice?.toFixed(2)}`}{' '}
        <span className="text-xs font-medium tracking-normal text-slate-400">
          {game.currency}
        </span>
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 border border-slate-600 bg-slate-800 text-slate-200 hover:border-slate-400 hover:bg-slate-800"
          onClick={() => onViewDetails(game)}
        >
          View Details
        </button>
        <button
          type="button"
          className={
            isTracked
              ? 'inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 border border-slate-600 bg-slate-800 text-slate-200 hover:border-slate-400 hover:bg-slate-800'
              : 'inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 bg-teal-300 text-slate-950 hover:bg-teal-200'
          }
          aria-pressed={isTracked}
          onClick={() => onToggleTrack(game.appId)}
        >
          {isTracked ? 'Remove from Watchlist' : 'Track Game'}
        </button>
      </div>
    </article>
  );
}

export default GameCard;
