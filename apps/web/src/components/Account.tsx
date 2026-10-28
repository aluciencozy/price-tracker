import { Link, useLocation } from 'react-router-dom';
import { Smartphone } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Status } from './Ui';
import { useEffect, useRef, useState } from 'react';
import { useApiSession, isAborted } from '../client/sessionContext';
import { RequestError } from './RequestError';
import { useRetryWait } from '../data/useRetryWait';
export default function Account() {
  const location = useLocation();
  const auth = useApiSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const wait = useRetryWait(error);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function logout() {
    if (!auth || busy || wait) return;
    setBusy(true);
    setError(undefined);
    controller.current = new AbortController();
    try {
      await auth.client.logout({ signal: controller.current.signal });
    } catch (error) {
      if (mounted.current && !isAborted(error)) setError(error);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1 tabIndex={-1}>Your space.</h1>
          <p>
            {auth
              ? 'Your verified account and current browser session.'
              : 'A sample account, with nothing behind the curtain.'}
          </p>
        </div>
        <Badge variant="secondary">
          {auth ? 'Verified account' : 'Sample account'}
        </Badge>
      </div>
      {auth && typeof location.state?.notice === 'string' ? (
        <Status>{location.state.notice}</Status>
      ) : null}
      {!auth && location.state?.preview ? (
        <div className="mb-6">
          <Status>
            Sign-in preview complete. No credentials were stored or
            transmitted, and no session was created.
          </Status>
        </div>
      ) : null}
      <div className="account-layout">
        <section>
          <h2>Account</h2>
          <dl className="account-facts">
            <div>
              <dt>Name</dt>
              <dd>
                {auth
                  ? (auth.session.user?.name ?? 'Not set')
                  : 'Sample player'}
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                {auth ? auth.session.user?.email : 'player@example.test'}
              </dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                {auth
                  ? 'Persistent HttpOnly cookie / server-revocable'
                  : 'Preview only / not authenticated'}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link to="/forgot">
                {auth ? 'Reset password' : 'Preview password reset'}
              </Link>
            </Button>
            {auth ? (
              <Button
                variant="ghost"
                disabled={busy || wait > 0}
                onClick={() => void logout()}
              >
                {busy ? 'Signing out…' : 'Sign out'}
              </Button>
            ) : (
              <Button asChild variant="ghost">
                <Link to="/login" state={{ signedOut: true }}>
                  Preview sign out
                </Link>
              </Button>
            )}
          </div>
          {error ? (
            <Status error>
              <RequestError error={error} />
            </Status>
          ) : null}
        </section>
        <section className="android-note">
          <Smartphone aria-hidden="true" />
          <h2>Alerts belong to each game.</h2>
          <p>
            Set email and Android push from a game’s tracker. Android push
            requires permission and a registered Android device. This website
            does not register devices or check device delivery readiness.
          </p>
          <p>
            This website does not request browser notification permission.
            Saving a preference is not proof of delivery.
          </p>
          <Button asChild variant="outline">
            <Link to="/watchlist">Open watchlist</Link>
          </Button>
        </section>
      </div>
      <Separator className="my-10" />
      <p className="muted-copy">
        {auth
          ? 'Watchlists are private. Alert preferences are not proof of delivery; the server schedules checks and sends eligible alerts.'
          : 'All sample changes reset on refresh. Real accounts, persistent sessions, shared watchlists, and alert delivery need the shared API.'}
      </p>
    </>
  );
}
