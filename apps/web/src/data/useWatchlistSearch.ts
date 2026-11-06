import { useEffect, useState } from 'react';
import type { TrackedItem, TrackerRepository } from './types';
import { isAborted } from '../client/sessionContext';

// Keep results only inside the mounted private watchlist, never across routes/sessions.
export function useWatchlistSearch(repository: TrackerRepository, query: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    items?: TrackedItem[];
    query?: string;
    attempt?: number;
    error?: unknown;
  }>({});
  const pending = state.query !== query || state.attempt !== attempt;
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      repository.list(query).then(
        (items) => {
          if (active) setState({ items, query, attempt });
        },
        (error: unknown) => {
          if (active && !isAborted(error))
            setState((previous) => ({ ...previous, query, attempt, error }));
        },
      );
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
      repository.cancelSearch?.();
    };
  }, [repository, query, attempt]);
  return {
    items: state.items,
    loading: pending,
    error: pending ? undefined : state.error,
    previous: Boolean(state.items && (pending || state.error)),
    retry: () => setAttempt((value) => value + 1),
  };
}
