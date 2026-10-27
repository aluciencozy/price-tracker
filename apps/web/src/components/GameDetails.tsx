import { useEffect, useRef } from "react";
import type { SteamGame } from "../types/SteamGame";

type GameDetailsProps = {
    game: SteamGame;
    onClose: () => void;
}

function GameDetails({ game, onClose }: GameDetailsProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = dialogRef.current;

        if (!dialog) return;

        dialog.showModal();

        return () => {
            if (dialog.open) dialog.close();
        };
    }, []);

    return (
        <dialog ref={dialogRef} className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-300 shadow-2xl backdrop:bg-slate-950/80 sm:p-8" aria-labelledby="game-details-title" onCancel={event => { event.preventDefault(); onClose(); }}>
            <p className="text-xs font-semibold uppercase tracking-widest text-teal-300">Steam · Sample data</p>
            <h2 id="game-details-title" className="mb-6 mt-2 text-2xl font-semibold text-white">{game.name}</h2>
            {game.imageUrl && <img className="mb-6 w-full rounded-lg" src={game.imageUrl} alt={game.name} />}

            <p className="mb-3 text-lg text-white">Current Price: ${game.currentPrice.toFixed(2)} {game.currency}</p>
            <p className="mb-3">Original Price: ${game.originalPrice.toFixed(2)} {game.currency}</p>
            <p>Current Discount: {game.discountPercent}%</p>
            <p className="mt-5 text-sm text-slate-400">Example prices only. No live price check has been made.</p>
            <button type="button" className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 bg-teal-300 text-slate-950 hover:bg-teal-200 mt-6" onClick={onClose} autoFocus>Close</button>
        </dialog>
    );
}

export default GameDetails;