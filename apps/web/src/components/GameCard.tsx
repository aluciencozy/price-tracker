import type { SteamGame } from "../types/SteamGame";

type GameCardProps = {
    game: SteamGame;
    isTracked: boolean;
    onToggleTrack: (appId: number) => void;
    onViewDetails: (game: SteamGame) => void;
}

function GameCard({ game, isTracked, onToggleTrack, onViewDetails }: GameCardProps) {
    return (
        <div className="game-card">
            {/* <img src={game.imageUrl} alt={game.name} /> */}

            <h2>{game.name}</h2>
            <p>Price: {game.currentPrice.toFixed(2)}</p>
            <p>Discount: {game.discountPercent}%</p>

            <button onClick={() => onViewDetails(game)}>
                View Details
            </button>

            <button onClick={() => onToggleTrack(game.appId)}>
                {isTracked ? "Remove from Watchlist" : "Track Game"}
            </button>
        </div>
    );
}

export default GameCard;