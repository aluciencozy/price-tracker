import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { TrackedItem, TrackerRepository } from '../data/types';
import { useAsync } from '../data/useAsync';
import GameCard from './GameCard';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { EmptyState, LoadingRows, Status } from './Ui';
import { useApiMode } from '../data/mode';
import { useWatchlistSearch } from '../data/useWatchlistSearch';
import { useRetryWait } from '../data/useRetryWait';
import { RequestError } from './RequestError';
export default function Watchlist({
  repository,
}: {
  repository: TrackerRepository;
}) {
  const api = useApiMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  return api
    ? <ApiWatchlist repository={repository} query={query} setQuery={setQuery} />
    : <SampleWatchlist repository={repository} query={query} setQuery={setQuery} />;
  function setQuery(value: string) {
    setSearchParams(value ? { q: value } : {}, { replace: true });
  }
}

type Props = {
  repository: TrackerRepository;
  query: string;
  setQuery(value: string): void;
};

function SampleWatchlist({ repository, query, setQuery }: Props) {
  const load = useCallback(
    () => repository.list(),
    [repository],
  );
  const { data: items, loading, error, retry } = useAsync(load);
  const filtered = items?.filter((item) =>
    item.product.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return <WatchlistView query={query} setQuery={setQuery} items={filtered} loading={loading} error={error} retry={retry} />;
}

function ApiWatchlist({ repository, query, setQuery }: Props) {
  const result = useWatchlistSearch(repository, query);
  return <WatchlistView query={query} setQuery={setQuery} {...result} />;
}

function WatchlistView({ query, setQuery, items, loading, error, retry, previous = false }: {
  query: string;
  setQuery(value: string): void;
  items?: TrackedItem[];
  loading: boolean;
  error?: unknown;
  retry(): void;
  previous?: boolean;
}) {
  const api = useApiMode();
  const wait = useRetryWait(error);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1 tabIndex={-1}>
            Watchlist<span className="title-period">.</span>
          </h1>
        </div>
        <Button asChild>
          <Link to="/add">
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add game
          </Link>
        </Button>
      </div>
      <div className="watchlist-toolbar">
        <FieldGroup className="max-w-sm">
          <Field>
            <FieldLabel className="sr-only" htmlFor="search">
              Search saved games
            </FieldLabel>
            <Input
              id="search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search games…"
            />
          </Field>
        </FieldGroup>
        <p role="status">
          {loading ? 'Searching…' : error ? 'Search unavailable' : `${items?.length ?? 0} ${items?.length === 1 ? 'game' : 'games'}${query ? ' found' : ' saved'}`}
        </p>
      </div>
      {previous ? <p role="status">Previous results — {loading ? 'searching for updated results.' : 'the latest search failed.'}</p> : null}
      {error ? (
        <Status error title={query ? `Could not search for “${query}”` : 'Could not load your watchlist'}>
          <RequestError error={error} />
          <Button variant="outline" disabled={wait > 0} onClick={retry}>Retry</Button>
          {query ? <Button variant="ghost" onClick={() => setQuery('')}>Clear search</Button> : null}
          {wait ? <p role="status">Retry available in {wait} seconds.</p> : null}
        </Status>
      ) : null}
      {loading && !items ? (
        <LoadingRows />
      ) : items ? (
        <>
          {!items.length && !previous ? (
            <EmptyState
              title={
                query
                  ? 'No saved games match'
                  : 'Your watchlist is empty'
              }
              description={query ? `Nothing on your list matches “${query}”. Try another title.` : 'Add a Steam link, choose your target, and keep it on your list.'}
            >
              {query ? <Button variant="outline" onClick={() => setQuery('')}>Clear search</Button> : <Button asChild>
                <Link to="/add">Add your first game</Link>
              </Button>}
            </EmptyState>
          ) : (
            <>
              <ul className="game-list" aria-label={previous ? 'Previous saved-game results' : 'Saved games'} aria-busy={loading}>
                {items.map((item) => (
                  <GameCard key={item.id} item={item} />
                ))}
              </ul>
              <p className="list-footnote">
                {api
                  ? 'Steam US/USD offers via CheapShark. Last successful observations are retained after failed checks. Preferences do not prove alert delivery.'
                  : 'Stale October 26, 2026 snapshots via CheapShark. Sample targets and preferences only; no alerts are sent.'}
              </p>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
