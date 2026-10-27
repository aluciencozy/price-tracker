import type { SteamGame } from "../types/SteamGame";

type WatchlistProps = {
    games: SteamGame[];
    onRemove: (appdID: number) => void;
}

function Watchlist({ games, onRemove }: WatchlistProps) {
    return (
        <div>
            <h2>My Watchlist</h2>

            {games.length === 0 ? (<p>You aren't tracking any games yet.</p>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th>Game</th>
                            <th>Price</th>
                            <th>Discount</th>
                            <th>Actions</th>
                        </tr>
                    </thead>

                    <tbody>
                        {games.map(game => (
                            <tr key={game.appId}>
                                <td>{game.name}</td>
                                <td>{game.currentPrice}</td>
                                <td>{game.discountPercent}</td>
                                <td>
                                    <button onClick={() => onRemove(game.appId)}>
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )
            }
        </div>
    );
}

export default Watchlist;