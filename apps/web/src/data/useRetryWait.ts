import { useEffect, useState } from 'react';
import { RepositoryError } from './types';
import { ClientError } from '../client/http';
export function errorDetails(error: unknown) {
  return error instanceof RepositoryError
    ? error.details
    : error instanceof ClientError
      ? error.details
      : undefined;
}
export function useRetryWait(error: unknown): number {
  const [wait, setWait] = useState<{
    error: unknown;
    until: number;
    now: number;
  }>();
  const seconds = errorDetails(error)?.retryAfterSeconds ?? 0;
  useEffect(() => {
    if (!seconds) return;
    const until = Date.now() + seconds * 1000;
    const tick = () => setWait({ error, until, now: Date.now() });
    const start = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
    };
  }, [error, seconds]);
  return seconds
    ? wait && wait.error === error
      ? Math.max(0, Math.ceil((wait.until - wait.now) / 1000))
      : seconds
    : 0;
}
