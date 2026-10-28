import { Link, useLocation } from 'react-router-dom';
import { Smartphone } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Status } from './Ui';
export default function Account() {
  const location = useLocation();
  return (
    <>
      <div className="page-heading">
        <div>
          <h1 tabIndex={-1}>Your space.</h1>
          <p>A sample account, with nothing behind the curtain.</p>
        </div>
        <Badge variant="secondary">Sample account</Badge>
      </div>
      {location.state?.preview ? (
        <div className="mb-6">
          <Status>
            Sign-in preview complete. No credentials were stored or transmitted,
            and no session was created.
          </Status>
        </div>
      ) : null}
      <div className="account-layout">
        <section>
          <h2>Account</h2>
          <dl className="account-facts">
            <div>
              <dt>Name</dt>
              <dd>Sample player</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>player@example.test</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>Preview only / not authenticated</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline">
              <Link to="/forgot">Preview password reset</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link to="/login" state={{ signedOut: true }}>
                Preview sign out
              </Link>
            </Button>
          </div>
        </section>
        <section className="android-note">
          <Smartphone aria-hidden="true" />
          <h2>Alerts belong to each game.</h2>
          <p>
            Set email and Android push from a game’s tracker. Android push
            requires permission and a registered device. No device is connected
            here.
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
        All sample changes reset on refresh. Real accounts, persistent sessions,
        shared watchlists, and alert delivery need the shared API.
      </p>
    </>
  );
}
