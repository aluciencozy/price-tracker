import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Gamepad2 } from 'lucide-react';
import { RepositoryError } from '../data/types';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty';
import { Skeleton } from './ui/skeleton';

export function Status({
  children,
  error = false,
  title,
}: {
  children: ReactNode;
  error?: boolean;
  title?: string;
}) {
  return (
    <Alert
      variant={error ? 'destructive' : 'default'}
      role={error ? 'alert' : 'status'}
    >
      {error ? <AlertCircle aria-hidden="true" /> : null}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
export function LoadError({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <Status
      error
      title={
        error instanceof RepositoryError && error.code === 'expired'
          ? 'Session expired (preview)'
          : 'Could not load this view'
      }
    >
      <p>
        {error instanceof Error
          ? error.message
          : 'Something went wrong. Try again.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {error instanceof RepositoryError && error.code === 'expired' ? (
          <Button asChild variant="outline">
            <Link to="/login">Sign in again</Link>
          </Button>
        ) : retry ? (
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        ) : null}
        <Button asChild variant="ghost">
          <Link to="/watchlist">Back to watchlist</Link>
        </Button>
      </div>
    </Status>
  );
}
export function LoadingRows() {
  return (
    <div
      role="status"
      aria-label="Loading games"
      className="flex flex-col gap-5"
    >
      {[1, 2].map((id) => (
        <div key={id} className="flex gap-5 py-6">
          <Skeleton className="h-16 w-28" />
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading games…</span>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Gamepad2 aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
