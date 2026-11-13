import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Pencil, Trash2 } from 'lucide-react';
import type { TrackedItem, TrackerRepository } from '../data/types';
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
import { useRetryWait } from '../data/useRetryWait';

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
      <GameDetails item={result.data} repository={repository} history={<PriceHistory
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
  history,
}: {
  item: TrackedItem;
  repository: TrackerRepository;
  history?: React.ReactNode;
}) {
  const { product } = item;
  const api = useApiMode();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    document.title = `${product.title} / Price Tracker${api ? '' : ' sample'}`;
  }, [product.title, api]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  const purchaseUrl = api
    ? product.currentPrice === null
      ? null
      : product.purchaseUrl
    : steamPurchaseUrl(product);
  const wait = useRetryWait(deleteError);
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
