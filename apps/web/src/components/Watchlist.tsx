import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { TrackerRepository } from '../data/types';
import { useAsync } from '../data/useAsync';
import GameCard from './GameCard';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { EmptyState, LoadError, LoadingRows } from './Ui';
import { useApiMode } from '../data/mode';
export default function Watchlist({
  repository,
}: {
  repository: TrackerRepository;
}) {
  const api = useApiMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const serverQuery = api ? query : undefined;
  const load = useCallback(
    () => repository.list(serverQuery),
    [repository, serverQuery],
  );
  const { data: items, loading, error, retry } = useAsync(load);
  function setQuery(value: string) {
    setSearchParams(value ? { q: value } : {}, { replace: true });
  }
  const filtered = items?.filter((item) =>
    item.product.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1 tabIndex={-1}>
            Your watchlist<span className="title-period">.</span>
          </h1>
          <p>A place for games worth waiting for.</p>
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
              placeholder="Search your saved games…"
            />
          </Field>
        </FieldGroup>
        <p role="status">
          {filtered?.length ?? 0} {filtered?.length === 1 ? 'game' : 'games'}
          {query ? ' found' : ' saved'}
        </p>
      </div>
      {loading ? (
        <LoadingRows />
      ) : error ? (
        <LoadError error={error} retry={retry} />
      ) : (
        <>
          {!items?.length ? (
            <EmptyState
              title={
                query
                  ? 'No saved games match'
                  : 'Make room for your next game'
              }
              description="Add a Steam link, choose your target, and keep it on your list."
            >
              <Button asChild>
                <Link to="/add">Add your first game</Link>
              </Button>
            </EmptyState>
          ) : !filtered?.length ? (
            <EmptyState
              title="No saved games match"
              description={`Nothing on your list matches “${query}”. Try another title.`}
            >
              <Button variant="outline" onClick={() => setQuery('')}>
                Clear search
              </Button>
            </EmptyState>
          ) : (
            <>
              <ul className="game-list" aria-label="Saved games">
                {filtered.map((item) => (
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
      )}
    </>
  );
}
