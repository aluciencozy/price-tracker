import { Link, useLocation } from 'react-router-dom';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
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
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function logout() {
    if (!auth || inFlight.current || wait) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    controller.current = new AbortController();
    try {
      await auth.client.logout({ signal: controller.current.signal });
    } catch (error) {
      if (mounted.current && !isAborted(error)) setError(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1 tabIndex={-1}>Account</h1>
          <p>
            {auth
              ? 'Your verified account and current browser session.'
              : 'Preview account settings.'}
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
          <h2>Profile</h2>
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
                  ? 'Signed in on this browser'
                  : 'Preview only / not authenticated'}
              </dd>
            </div>
          </dl>
          <h2>Security</h2>
          <div className="account-actions flex flex-wrap gap-3">
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
          <h2>Notifications</h2>
          <p>
            Manage alerts per game. Android push requires an opted-in registered
            device; this website does not register devices or check readiness.
            Browser push is not supported, and preferences do not confirm delivery.
          </p>
          <Button asChild variant="outline">
            <Link to="/watchlist">Open watchlist</Link>
          </Button>
        </section>
      </div>
    </>
  );
}
