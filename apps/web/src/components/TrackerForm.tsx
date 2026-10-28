import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Link2 } from 'lucide-react';
import {
  RepositoryError,
  type ProductPreview,
  type TrackedItem,
  type TrackerRepository,
} from '../data/types';
import { formatMoney, parseTarget } from '../data/validation';
import { useAsync } from '../data/useAsync';
import { GameArt } from './GameCard';
import PreferencesFields from './PreferencesFields';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from './ui/field';
import { Input } from './ui/input';
import { LoadError, LoadingRows, Status } from './Ui';
import { useApiMode } from '../data/mode';
import { isAborted } from '../client/sessionContext';
import { RequestError } from './RequestError';
import { useRetryWait } from '../data/useRetryWait';

export function TrackerEditor({
  repository,
}: {
  repository: TrackerRepository;
}) {
  const { id = '' } = useParams();
  const load = useCallback(() => repository.get(id), [repository, id]);
  const result = useAsync(load);
  return result.loading ? (
    <LoadingRows />
  ) : result.error ? (
    <LoadError error={result.error} retry={result.retry} />
  ) : result.data ? (
    <TrackerForm repository={repository} item={result.data} />
  ) : null;
}
export default function TrackerForm({
  repository,
  item,
}: {
  repository: TrackerRepository;
  item?: TrackedItem;
}) {
  const navigate = useNavigate();
  const api = useApiMode();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<ProductPreview | null>(null);
  const product = item?.product ?? preview?.product;
  const [target, setTarget] = useState(
    item ? (item.targetPrice.amountMinor / 100).toFixed(2) : '',
  );
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [alerts, setAlerts] = useState(
    item?.alerts ?? { email: true, push: false },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [invalidTarget, setInvalidTarget] = useState(false);
  const wait = useRetryWait(error);
  const cancelTo = item ? `/watchlist/${item.id}` : '/watchlist';
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || wait) return;
    setBusy(true);
    setError(undefined);
    setInvalidTarget(false);
    try {
      if (!product) {
        const result = await repository.preview(url);
        if (mounted.current) setPreview(result);
        return;
      }
      let targetPrice;
      try {
        targetPrice = parseTarget(target);
      } catch (error) {
        setInvalidTarget(true);
        throw error;
      }
      const prefs = { targetPrice, enabled, alerts };
      const saved = item
        ? await repository.update(item.id, prefs)
        : await repository.create({ previewId: preview!.id, ...prefs });
      if (mounted.current)
        navigate(`/watchlist/${saved.id}`, {
          state: {
            notice: api ? (item ? 'Tracker updated. A target edit is not a price drop and creates no history.' : 'Game saved. Alert preferences are not proof of delivery.') : item
              ? 'Sample tracker updated. A target edit is not a price drop; price and history are unchanged.'
              : 'Game saved to your sample watchlist. No alerts were sent.',
          },
        });
    } catch (error) {
      if (mounted.current && !isAborted(error)) setError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <Button asChild variant="ghost">
        <Link to={cancelTo}>
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          {item ? 'Back to game' : 'Back to watchlist'}
        </Link>
      </Button>
      <div className="page-heading">
        <div>
          <h1 tabIndex={-1}>
            {item ? 'Make it your price.' : 'Add your next game.'}
          </h1>
          <p>
            {item
              ? 'One game. Your target and preferences.'
              : 'A Steam link is all you need to start.'}
          </p>
        </div>
      </div>
      <div className="form-layout">
        <section
          className="form-surface"
          aria-label={item ? 'Edit tracker' : 'Add game'}
        >
          {!item ? (
            <ol className="form-steps" aria-label="Add game progress">
              <li aria-current={!product ? 'step' : undefined}>
                <span>{product ? <Check aria-label="Complete" /> : '1'}</span>
                Preview offer
              </li>
              <li aria-current={product ? 'step' : undefined}>
                <span>2</span>Set your target
              </li>
            </ol>
          ) : null}
          <form onSubmit={(event) => void submit(event)}>
            <FieldSet disabled={busy || wait > 0} aria-busy={busy}>
              {!product ? (
                <FieldGroup>
                  <Field data-invalid={Boolean(error)}>
                    <FieldLabel htmlFor="steam-url">
                      Steam base-game URL
                    </FieldLabel>
                    <Input
                      id="steam-url"
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        setError(undefined);
                      }}
                      placeholder="https://store.steampowered.com/app/620/"
                      required
                      aria-invalid={Boolean(error)}
                      aria-describedby="url-help"
                    />
                    <FieldDescription id="url-help">
                      {api ? 'Only supported Steam base-game links. The submitted URL is parsed, never fetched; the API validates the exact offer.' : 'Parsed locally; never fetched. This sample recognizes Portal 2 and Half-Life 2.'}
                    </FieldDescription>
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() =>
                        setUrl('https://store.steampowered.com/app/620/')
                      }
                    >
                      Use Portal 2 link
                    </Button>
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() =>
                        setUrl('https://store.steampowered.com/app/220/')
                      }
                    >
                      Use Half-Life 2 link
                    </Button>
                  </div>
                  <Button type="submit" disabled={busy}>
                    <Link2 data-icon="inline-start" aria-hidden="true" />
                    {busy ? 'Previewing…' : 'Preview offer'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => navigate(cancelTo)}
                  >
                    Cancel
                  </Button>
                </FieldGroup>
              ) : (
                <>
                  <div className="offer-preview">
                    <GameArt product={product} />
                    <div>
                      <h2>{product.title}</h2>
                      <p>Steam / US / USD</p>
                      <Badge variant="secondary">
                        {api ? 'Validated base-game offer' : 'Base game / sample match'}
                      </Badge>
                    </div>
                    <strong>{formatMoney(product.currentPrice)}</strong>
                  </div>
                  <p className="form-recorded">
                    {api ? `${product.freshness} Steam offer via CheapShark. Last successful observation: ${product.observedAt ?? 'none'}. Not a checkout quote.` : 'Stale October 26, 2026 snapshot via CheapShark. Not a live quote.'}
                  </p>
                  {!item ? (
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => {
                        setPreview(null);
                        setError(undefined);
                      }}
                    >
                      Change Steam link
                    </Button>
                  ) : null}
                  <div className="tracker-preferences">
                    <PreferencesFields
                      target={target}
                      onTarget={setTarget}
                      enabled={enabled}
                      onEnabled={setEnabled}
                      alerts={alerts}
                      onAlerts={setAlerts}
                      invalid={invalidTarget}
                    />
                  </div>
                  <div className="form-actions">
                    <Button type="submit" disabled={busy}>
                      {busy ? 'Saving…' : item ? 'Save changes' : 'Save game'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => navigate(cancelTo)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </FieldSet>
          </form>
          {error ? (
            <div className="mt-5">
              <Status error>
                <RequestError error={error} />
                {error instanceof RepositoryError &&
                error.code === 'duplicate' &&
                error.resourceId ? (
                  <Link
                    className="text-link"
                    to={`/watchlist/${error.resourceId}`}
                  >
                    Open existing tracker
                  </Link>
                ) : null}
                {error instanceof RepositoryError &&
                error.code === 'preview-expired' ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPreview(null);
                      setError(undefined);
                    }}
                  >
                    Preview again
                  </Button>
                ) : null}
                {error instanceof RepositoryError &&
                error.code === 'expired' ? (
                  <Link className="text-link" to="/login">
                    Sign in again
                  </Link>
                ) : null}
              </Status>
            </div>
          ) : null}
          {wait ? <p role="status">Retry available in {wait} seconds.</p> : null}
        </section>
        <aside className="form-aside">
          <h2>One exact offer.</h2>
          <p>
            Steam base games, in US dollars. No bundles, DLC, subscriptions, or
            guessed editions.
          </p>
          <p>
            The planned daily checks compare your chosen Steam offer with your
            target. A failed check keeps the last successful price.
          </p>
          <p>
            {api ? 'Changes save to your private account. Scheduled checks and alerts require the configured backend; this form does not trigger a price check.' : 'Sample changes stay in memory and reset on refresh. Nothing is sent or scheduled.'}
          </p>
        </aside>
      </div>
    </>
  );
}
