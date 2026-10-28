import { useCallback, useState } from 'react';
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
      <GameDetails item={result.data} repository={repository} />
      <PriceHistory
        history={history.data}
        target={result.data.targetPrice}
        loading={history.loading}
        error={history.error}
        retry={history.retry}
      />
    </>
  ) : null;
}
export default function GameDetails({
  item,
  repository,
}: {
  item: TrackedItem;
  repository: TrackerRepository;
}) {
  const { product } = item;
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const purchaseUrl = steamPurchaseUrl(product);
  async function remove() {
    setDeleting(true);
    setDeleteError('');
    try {
      await repository.remove(item.id);
      navigate('/watchlist');
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : 'Removal failed. Nothing changed. Try again.',
      );
    } finally {
      setDeleting(false);
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
          <p>Steam base game / US / USD</p>
        </div>
        <Badge variant="secondary">{trackerStatus(item)}</Badge>
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
          <Button asChild variant="outline">
            <Link to={`/watchlist/${item.id}/edit`}>
              <Pencil data-icon="inline-start" aria-hidden="true" />
              Edit tracker
            </Link>
          </Button>
          {purchaseUrl ? (
            <Button asChild>
              <a href={purchaseUrl} target="_blank" rel="noopener noreferrer">
                Open Steam deal via CheapShark
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
      <div className="detail-meta">
        <div>
          <h2>About this price</h2>
          <p>
            Stale recorded Steam offer from 2026-10-26 via{' '}
            <a
              className="text-link"
              href="https://www.cheapshark.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              CheapShark
            </a>
            . Not a live checkout quote. Any retained purchase link is dated and
            unconfirmed.
          </p>
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
                  'Not recorded in the source proof'}
              </dd>
            </div>
          </dl>
        </div>
        <div>
          <h2>Your preferences</h2>
          <dl>
            <div>
              <dt>Tracking</dt>
              <dd>{item.enabled ? 'Enabled' : 'Paused'}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{item.alerts.email ? 'On' : 'Off'}</dd>
            </div>
            <div>
              <dt>Android push</dt>
              <dd>{item.alerts.push ? 'On / no connected device' : 'Off'}</dd>
            </div>
          </dl>
          <p>
            Preferences only. No sample delivery, browser push, or background
            checks. A target edit does not change price history.
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
                This removes its sample target and preferences from your
                watchlist. You can add it again. No real account is changed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? <Status error>{deleteError}</Status> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                Keep game
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleting}
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
