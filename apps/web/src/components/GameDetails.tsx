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
        <dialog ref={dialogRef} className="game-details" onCancel={event => { event.preventDefault(); onClose(); }}>
            <h1>{game.name}</h1>
            <img src={game.imageUrl} alt={game.name} />

            <p>Current Price: {game.currentPrice.toFixed(2)}</p>
            <p>Original Price: {game.originalPrice.toFixed(2)}</p>
            <p>Current Discount: {game.discountPercent}%</p>
            <button onClick={onClose}>Close</button>
        </dialog>
    );
}

export default GameDetails;