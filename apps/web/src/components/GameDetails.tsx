import type { SteamGame } from '../types/SteamGame';
import { Btn, Panel } from './Ui';
import { steamPurchaseUrl } from '../steamPurchaseUrl';

type GameDetailsProps = {
  game: SteamGame;
  onClose: () => void;
  onEdit: () => void;
  targetMinor?: number;
  unavailable: boolean;
};

export default function GameDetails({
  game,
  onClose,
  onEdit,
  targetMinor,
  unavailable,
}: GameDetailsProps) {
  const missingOffer = unavailable || game.currentPrice === null;
  const purchaseUrl = missingOffer ? null : steamPurchaseUrl(game);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel title={game.name}>
          <p className="mb-5 text-sm text-slate-400">
            Steam app ID {game.appId} · Example base game · {game.currency}
          </p>
          {game.imageUrl && (
            <img
              className="mb-6 w-full rounded-lg"
              src={game.imageUrl}
              alt={game.name}
            />
          )}
          <dl className="mb-5 grid grid-cols-2 gap-4">
            <div>
              <dt className="text-sm text-slate-400">Current Price</dt>
              <dd className="text-xl font-bold">
                {missingOffer
                  ? 'Price unavailable'
                  : `$${game.currentPrice?.toFixed(2)} ${game.currency}`}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-slate-400">Your target</dt>
              <dd className="text-xl font-bold">
                {targetMinor === undefined
                  ? 'Not set'
                  : `$${(targetMinor / 100).toFixed(2)}`}
              </dd>
            </div>
          </dl>
          {!missingOffer && (
            <>
              <p className="mb-3">
                Original Price: ${game.originalPrice.toFixed(2)} {game.currency}
              </p>
              <p>Current Discount: {game.discountPercent}%</p>
            </>
          )}
          <p className="mt-5 text-sm text-slate-400">
            Example prices only. No live price check has been made.
          </p>
          {game.steamOffer && (
            <p className="mt-3 text-sm text-slate-400">
              Recorded Steam offer from {game.steamOffer.observedAt}, supplied
              by{' '}
              <a
                className="underline"
                href="https://www.cheapshark.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                CheapShark
              </a>
              . This is not a live quote; the deal may have changed or expired.
            </p>
          )}
          {purchaseUrl ? (
            <a
              className="mt-4 inline-block rounded-lg bg-teal-300 px-4 py-2.5 font-semibold text-slate-950 hover:bg-teal-200"
              href={purchaseUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Steam deal via CheapShark
            </a>
          ) : (
            <p className="mt-3 text-sm text-slate-400">
              {missingOffer
                ? 'Steam offer unavailable. Purchase unavailable.'
                : 'Purchase link unavailable until the API supplies a valid matching Steam deal ID.'}
            </p>
          )}
          {game.currentPrice === null && (
            <p className="mt-3 text-sm text-slate-400">
              Missing-offer example only; this does not describe the game’s live
              Steam availability.
            </p>
          )}
          <h3 className="mb-3 mt-6 font-semibold">Price history</h3>
          <div className="rounded-lg border border-dashed border-slate-600 p-8 text-center text-sm text-slate-400">
            No observed price history yet. Successful API checks will supply
            this chart.
          </div>
        </Panel>
      </div>
      <Panel title="Actions">
        <div className="flex flex-col items-start gap-3">
          <Btn onClick={onEdit}>Edit target</Btn>
          <Btn variant="secondary" onClick={onClose}>
            Back to watchlist
          </Btn>
        </div>
      </Panel>
    </div>
  );
}
