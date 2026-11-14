import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { PriceRefresh, RefreshTrackerRepository, TrackedItem, TrackerRepository } from '../data/types';
import { useAsync } from '../data/useAsync';
import { formatMoney, trackerStatus } from '../data/validation';
import { steamPurchaseUrl } from '../steamPurchaseUrl';
import { GameArt } from './GameCard';
import PriceHistory from './PriceHistory';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';
import { LoadError, LoadingRows, Status } from './Ui';
import { useApiMode } from '../data/mode';
import { isAborted } from '../client/sessionContext';
import { RequestError } from './RequestError';
import { useRetryUntil, useRetryWait } from '../data/useRetryWait';

const repositoryKeys = new WeakMap<TrackerRepository, number>();
let nextRepositoryKey = 0;
function repositoryKey(repository: TrackerRepository): number {
  let key = repositoryKeys.get(repository);
  if (key === undefined) {
    key = nextRepositoryKey++;
    repositoryKeys.set(repository, key);
  }
  return key;
}

function isRefreshRepository(repository: TrackerRepository): repository is TrackerRepository & RefreshTrackerRepository {
  return 'refreshPrice' in repository && typeof repository.refreshPrice === 'function' &&
    'resumeRefresh' in repository && typeof repository.resumeRefresh === 'function';
}
function refreshTime(value: string | null | undefined): string {
  return value ? value.replace('T', ' ').replace('Z', ' UTC') : 'time unavailable';
}
function refreshStatusText(refresh: PriceRefresh): string {
  switch (refresh.status) {
    case 'queued': return 'This price check is still queued. No new price is confirmed yet.';
    case 'running': return 'The server is checking this game’s Steam offer.';
    case 'cached': return `Used the recorded price from ${refreshTime(refresh.lastObservation?.observedAt)}. No new provider fetch or history observation was created.`;
    case 'refreshed': return `Recorded a successful price observation at ${refreshTime(refresh.lastObservation?.observedAt)}. This does not mean the price dropped or confirm email/push delivery.`;
    case 'deferred': return `The provider deferred this check. ${refresh.error?.message ?? 'Wait before trying again.'}`;
    case 'failed': return `Price check failed. ${refresh.error?.message ?? 'The last successful price and history are unchanged.'}`;
  }
}

export function GameDetailsPage({
  repository,
}: {
  repository: TrackerRepository;
}) {
  const { id = '' } = useParams();
  const load = useCallback(() => repository.get(id), [repository, id]);
  const loadHistory = useCallback(
    () => repository.history(id),
    [repository, id],
  );
  const result = useAsync(load);
  const history = useAsync(loadHistory);
  const notice: unknown = useLocation().state?.notice;
  const [refreshCheckpoint, setRefreshCheckpoint] = useState<{
    trackerId: string;
    repository: TrackerRepository;
    refresh: PriceRefresh;
  }>();
  const currentCheckpoint =
    refreshCheckpoint?.trackerId === id && refreshCheckpoint.repository === repository
      ? refreshCheckpoint
      : undefined;
  const refreshNotice = currentCheckpoint
    ? refreshStatusText(currentCheckpoint.refresh)
    : undefined;
  const onRefreshComplete = useCallback((refresh: PriceRefresh) => {
    setRefreshCheckpoint({ trackerId: id, repository, refresh });
    result.retry();
    history.retry();
  }, [history, id, repository, result]);
  const clearRefreshCheckpoint = useCallback(() => {
    setRefreshCheckpoint((current) =>
      current?.trackerId === id && current.repository === repository
        ? undefined
        : current,
    );
  }, [id, repository]);
  return result.loading ? (
    <LoadingRows />
  ) : result.error ? (
    <LoadError error={result.error} retry={result.retry} />
  ) : result.data ? (
    <>
      {typeof notice === 'string' ? (
        <div className="mb-6">
          <Status>{notice}</Status>
        </div>
      ) : null}
      <GameDetails key={`${id}:${repositoryKey(repository)}`} item={result.data} repository={repository}
        initialRefresh={currentCheckpoint?.refresh} refreshNotice={refreshNotice}
        onRefreshComplete={onRefreshComplete} onRefreshStart={clearRefreshCheckpoint} history={<PriceHistory
        history={history.data}
        target={result.data.targetPrice}
        loading={history.loading}
        error={history.error}
        retry={history.retry}
      />} />
    </>
  ) : null;
}
export default function GameDetails({
  item,
  repository,
  initialRefresh,
  history,
  refreshNotice,
  onRefreshComplete,
  onRefreshStart,
}: {
  item: TrackedItem;
  repository: TrackerRepository;
  initialRefresh?: PriceRefresh;
  history?: React.ReactNode;
  refreshNotice?: string;
  onRefreshComplete?: (refresh: PriceRefresh) => void;
  onRefreshStart?: () => void;
}) {
  const { product } = item;
  const api = useApiMode();
  const navigate = useNavigate();
  const mounted = useRef(true);
  const refreshLock = useRef(false);
  const refreshController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshController.current?.abort();
    };
  }, []);
  useEffect(() => {
    document.title = `${product.title} / Price Tracker${api ? '' : ' sample'}`;
  }, [product.title, api]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<PriceRefresh | undefined>(initialRefresh);
  const [refreshError, setRefreshError] = useState<unknown>();
  const [refreshPollingStopped, setRefreshPollingStopped] = useState(false);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const purchaseUrl = api
    ? product.currentPrice === null
      ? null
      : product.purchaseUrl
    : steamPurchaseUrl(product);
  const wait = useRetryWait(deleteError);
  const refreshWait = Math.max(
    useRetryWait(refreshError),
    useRetryUntil(refreshResult?.retryAt),
  );
  const refreshRepository = isRefreshRepository(repository) ? repository : null;
  const canResumeRefresh =
    refreshResult?.status === 'queued' ||
    refreshResult?.status === 'running' ||
    refreshResult?.status === 'deferred';
  async function refreshPrice(resume = false) {
    if (!api || !refreshRepository || refreshing || refreshLock.current || refreshWait > 0) return;
    const retained = resume ? refreshResult : undefined;
    if (resume && !retained) return;
    refreshLock.current = true;
    const controller = new AbortController();
    refreshController.current = controller;
    if (!resume) onRefreshStart?.();
    setRefreshing(true);
    setRefreshingStatus(resume);
    if (!resume) setRefreshResult(undefined);
    setRefreshError(undefined);
    if (!resume) setRefreshPollingStopped(false);
    const publishStatus = (status: PriceRefresh) => {
      if (!mounted.current) return;
      setRefreshResult(status);
    };
    try {
      const result = resume
        ? await refreshRepository.resumeRefresh(
            retained!.id,
            item.id,
            publishStatus,
            { signal: controller.signal },
          )
        : await refreshRepository.refreshPrice(
            item.id,
            publishStatus,
            { signal: controller.signal },
          );
      if (!mounted.current) return;
      setRefreshResult(result);
      setRefreshPollingStopped(result.status === 'queued' || result.status === 'running');
      if (result.status === 'cached' || result.status === 'refreshed') {
        onRefreshComplete?.(result);
      }
    } catch (error) {
      if (mounted.current && !isAborted(error)) setRefreshError(error);
    } finally {
      refreshLock.current = false;
      if (mounted.current) {
        setRefreshing(false);
        setRefreshingStatus(false);
      }
    }
  }
  async function remove() {
    if (deleting || wait) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await repository.remove(item.id);
      if (mounted.current) navigate('/watchlist');
    } catch (error) {
      if (mounted.current && !isAborted(error)) setDeleteError(error);
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  return (
    <>
      <Button asChild variant="ghost">
        <Link to="/watchlist">
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          Back to watchlist
        </Link>
      </Button>
      <div className="detail-header">
        <GameArt product={product} />
        <div>
          <h1 tabIndex={-1}>{product.title}</h1>
          <p>{api ? 'Steam app / US / USD' : 'Steam base game / US / USD'}</p>
        </div>
        <Badge variant="secondary">{trackerStatus(item, !api)}</Badge>
      </div>
      {product.lastError ? (
        <div className="mb-6">
          <Status error title="Last-known price preserved">
            <p>{product.lastError.message}</p>
            <p>
              Failed attempt:{' '}
              {product.lastError.occurredAt
                .replace('T', ' ')
                .replace('Z', ' UTC')}
            </p>
          </Status>
        </div>
      ) : null}
      <div className="detail-summary">
        <dl className="detail-prices">
          <div>
            <dt>Last-known Steam price</dt>
            <dd>
              {formatMoney(product.currentPrice)}
              {product.currentPrice ? <small> USD</small> : null}
            </dd>
          </div>
          <div>
            <dt>Your target</dt>
            <dd>
              {formatMoney(item.targetPrice)}
              <small> USD</small>
            </dd>
          </div>
        </dl>
        <div className="detail-actions">
          {api && refreshRepository ? (
            <Button
              variant="outline"
              disabled={refreshing || refreshWait > 0}
              aria-busy={refreshing}
              onClick={() => void refreshPrice(canResumeRefresh)}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {refreshing
                ? refreshingStatus ? 'Checking status…' : 'Checking price…'
                : refreshWait > 0
                  ? `${canResumeRefresh ? 'Check status' : 'Check price'} in ${refreshWait}s`
                  : canResumeRefresh ? 'Check status' : 'Check price now'}
            </Button>
          ) : null}
          <Button asChild>
            <Link to={`/watchlist/${item.id}/edit`}>
              <Pencil data-icon="inline-start" aria-hidden="true" />
              Edit tracker
            </Link>
          </Button>
          {purchaseUrl ? (
            <Button asChild variant="outline">
              <a href={purchaseUrl} target="_blank" rel="noopener noreferrer">
                View Steam offer via CheapShark
                <ArrowUpRight data-icon="inline-end" aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <p className="muted-copy">
              Steam offer unavailable. Purchase unavailable.
            </p>
          )}
        </div>
      </div>
      <p className="detail-freshness">
        {product.currentPrice === null
          ? 'No Steam price available. Source: CheapShark.'
          : api
            ? `${product.freshness} Steam offer via CheapShark. Not a live checkout quote; purchase links may expire.`
            : 'Recorded Oct 26, 2026 · CheapShark · Not a live quote. Purchase link is dated and unconfirmed.'}
      </p>
      {refreshNotice ? <Status>{refreshNotice}</Status> : null}
      {refreshResult && !['refreshed', 'cached'].includes(refreshResult.status) ? (
        <Status error={refreshResult.status === 'failed'} title={refreshResult.status === 'queued' ? 'Check queued' : refreshResult.status === 'running' ? 'Check in progress' : refreshResult.status === 'deferred' ? 'Check deferred' : 'Check status'}>
          <p>{refreshStatusText(refreshResult)}</p>
          {refreshWait > 0 ? <p>Try again in {refreshWait} seconds.</p> : null}
        </Status>
      ) : null}
      {refreshError ? (
        <Status error title="Could not check price">
          <RequestError error={refreshError} />
          {refreshWait > 0 ? <p>Try again in {refreshWait} seconds.</p> : null}
        </Status>
      ) : null}
      {refreshing ? <p role="status" aria-live="polite">{refreshResult ? refreshStatusText(refreshResult) : 'Submitting price check…'}</p> : null}
      {refreshPollingStopped && refreshResult && !refreshing ? (
        <p role="status">
          Automatic status checks stopped. The last received status was {refreshResult.status}; it may have completed since. Check status to update it.
        </p>
      ) : null}
      {refreshWait > 0 ? <p role="status">Price check available in {refreshWait} seconds.</p> : null}
      {history}
      <div className="detail-meta">
        <details>
          <summary>Price details</summary>
          <dl>
            <div>
              <dt>Last successful observation</dt>
              <dd>
                {product.observedAt
                  ? product.observedAt.replace('T', ' ').replace('Z', ' UTC')
                  : 'No successful observation'}
              </dd>
            </div>
            <div>
              <dt>Provider price-change time</dt>
              <dd>
                {product.providerChangedAt ??
                  (api
                    ? 'Not supplied by the provider'
                    : 'Not recorded in the source proof')}
              </dd>
            </div>
            {api ? (
              <>
                <div>
                  <dt>Last attempt</dt>
                  <dd>{product.lastAttemptAt ?? 'Not attempted'}</dd>
                </div>
                <div>
                  <dt>Stale after</dt>
                  <dd>{product.staleAt ?? 'No successful observation'}</dd>
                </div>
                <div>
                  <dt>Next estimated check</dt>
                  <dd>{product.nextCheckAt ?? 'Not scheduled'}</dd>
                </div>
              </>
            ) : null}
          </dl>
        </details>
        <div>
          <h2>Your preferences</h2>
          <p>Tracking {item.enabled ? 'on' : 'paused'} · Email {item.alerts.email ? 'on' : 'off'} · Android push {item.alerts.push ? 'on' : 'off'}</p>
          <p>
            {api
              ? 'Android push needs an opted-in registered device, not browser push. Preferences do not confirm delivery.'
              : 'Android push needs an opted-in registered device, not browser push. Sample alerts are not delivered.'}
          </p>
        </div>
      </div>
      <div className="remove-section">
        <AlertDialog
          open={confirm}
          onOpenChange={(value) => {
            if (!deleting) {
              setConfirm(value);
              setDeleteError('');
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 data-icon="inline-start" aria-hidden="true" />
              Remove game
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {product.title}?</AlertDialogTitle>
              <AlertDialogDescription>
                {api
                  ? 'This removes your saved tracker and cancels future unsent alerts for it. Shared history and other accounts are unchanged. Already delivered messages cannot be recalled.'
                  : 'This removes its sample target and preferences from your watchlist. You can add it again. No real account is changed.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? (
              <Status error>
                <RequestError error={deleteError} />
              </Status>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                Keep game
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleting || wait > 0}
                onClick={(event) => {
                  event.preventDefault();
                  void remove();
                }}
              >
                {deleting ? 'Removing…' : 'Remove from watchlist'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}
