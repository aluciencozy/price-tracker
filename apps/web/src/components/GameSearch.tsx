type GameSearchProps = {
    query: string;
    onSearch: (input: string) => void;
};

function GameSearch({ query, onSearch }: GameSearchProps) {
    return (
        <div>
            <input
                type="search"
                placeholder="Search for Steam games..."
                value={query}
                onChange={(event) => onSearch(event.target.value)}
            />
        </div>
    );
}

export default GameSearch;