type GameSearchProps = {
    query: string;
    onSearch: (input: string) => void;
};

function GameSearch({ query, onSearch }: GameSearchProps) {
    return (
        <div>
            <label htmlFor="game-search" className="mb-2 block text-sm font-medium text-slate-300">Search example games</label>
            <input
                id="game-search"
                className="w-full rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-3 text-white placeholder:text-slate-500 focus:border-teal-300 focus:outline-2 focus:outline-offset-2 focus:outline-teal-300"
                type="search"
                placeholder="Search by game name…"
                value={query}
                onChange={(event) => onSearch(event.target.value)}
            />
        </div>
    );
}

export default GameSearch;
