import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import { WebClient } from './webClient';
import { createApiRepository } from './apiRepository';
import { SessionContext, useApiSession } from './sessionContext';
import { Status } from '../components/Ui';
import { Button } from '../components/ui/button';
import type { TrackerRepository } from '../data/types';
import { useRetryWait } from '../data/useRetryWait';
import { RequestError } from '../components/RequestError';

export function ApiSession({
  client,
  children,
}: {
  client: WebClient;
  children: ReactNode;
}) {
  const session = useSyncExternalStore(client.subscribe, client.getSession);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ busy: boolean; error?: unknown }>({
    busy: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    client.restoreSession({ signal: controller.signal }).then(
      () => {
        if (!controller.signal.aborted) setState({ busy: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ busy: false, error });
      },
    );
    return () => controller.abort();
  }, [client, attempt]);
  return (
    <SessionContext.Provider
      value={{
        client,
        session,
        ...state,
        retry: () => {
          setState({ busy: true });
          setAttempt((n) => n + 1);
        },
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

function OwnedView({
  client,
  render,
}: {
  client: WebClient;
  render(repository: TrackerRepository): ReactNode;
}) {
  const [repository] = useState(() => createApiRepository(client));
  useEffect(() => () => repository.cancelPending(), [repository]);
  return render(repository);
}
export function PrivateView({
  render,
}: {
  render(repository: TrackerRepository): ReactNode;
}) {
  const auth = useApiSession()!;
  const location = useLocation();
  const wait = useRetryWait(auth.error);
  if (auth.session.status === 'authenticated') {
    return (
      <OwnedView
        key={`${location.pathname}:${auth.session.user.id}:${auth.session.sessionId ?? ''}`}
        client={auth.client}
        render={render}
      />
    );
  }
  if (auth.busy) return <Status>Restoring your session…</Status>;
  if (auth.session.status === 'unknown')
    return (
      <Status error title="Session could not be checked">
        <p>
          We could not confirm your session. This is not a sign-out. Check
          your connection and retry.
        </p>
        {auth.error ? <RequestError error={auth.error} /> : null}
        <Button disabled={wait > 0} onClick={auth.retry}>
          {wait ? `Retry session in ${wait}s` : 'Retry session'}
        </Button>
      </Status>
    );
  return (
    <Status title="Sign in to continue">
      <p>
        Your session is missing, expired or revoked. Private data has been
        cleared.
      </p>
      <Button asChild>
        <Link to="/login">Sign in</Link>
      </Button>
    </Status>
  );
}
