import type { SteamGame } from "../types/SteamGame";

type WatchlistProps = {
    games: SteamGame[];
    onRemove: (appId: number) => void;
};

function Watchlist({ games, onRemove }: WatchlistProps) {
    return (
        <section className="mb-8 rounded-2xl border border-slate-700 bg-slate-900/80 p-6 sm:p-8" aria-labelledby="watchlist-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="watchlist-title" className="text-xl font-semibold text-white">My Watchlist</h2>
                <span className="rounded-full border border-slate-600 px-3 py-1 text-xs font-medium text-slate-300">{games.length} {games.length === 1 ? 'game' : 'games'}</span>
            </div>
            <p className="mt-2 text-sm text-slate-400">Session preview · selections are not saved.</p>
            {games.length === 0 ? (
                <div className="mt-6 rounded-xl border border-dashed border-slate-700 p-6 text-center text-slate-400">
                    <p className="font-medium text-slate-200">You aren't tracking any games yet.</p>
                    <p className="mt-2 text-sm">Choose Track Game above to try the watchlist.</p>
                </div>
            ) : (
                <div className="mt-6 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <caption className="sr-only">Selected example games and sample USD prices</caption>
                        <thead className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
                            <tr>
                                <th scope="col" className="py-3 pr-6">Game</th>
                                <th scope="col" className="py-3 pr-6">Price (USD)</th>
                                <th scope="col" className="py-3 pr-6">Discount</th>
                                <th scope="col" className="py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {games.map(game => (
                                <tr key={game.appId}>
                                    <th scope="row" className="py-4 pr-6 font-medium text-white">{game.name}</th>
                                    <td className="whitespace-nowrap py-4 pr-6">${game.currentPrice.toFixed(2)}</td>
                                    <td className="py-4 pr-6">{game.discountPercent}%</td>
                                    <td className="py-4 text-right">
                                        <button type="button" className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-300 border border-slate-600 bg-slate-950/40 text-slate-200 hover:border-slate-400 hover:bg-slate-800" aria-label={`Remove ${game.name} from watchlist`} onClick={() => onRemove(game.appId)}>Remove</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

export default Watchlist;
