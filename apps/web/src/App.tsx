import { useCallback, useEffect, useState } from 'react';
import { ApiModeContext } from './data/mode';
import { ApiSession, PrivateView } from './client/ApiSession';
import {
  createRuntime,
  type Runtime,
  type EmailLink,
} from './client/runtime';
import ApiAuthScreen from './components/ApiAuthScreen';
import { useApiSession } from './client/sessionContext';
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import {
  sampleScenarios,
  type SampleScenario,
} from './data/sampleRepository';
import type { TrackerRepository } from './data/types';
import Header from './components/Header';
import Home from './components/Home';
import Watchlist from './components/Watchlist';
import TrackerForm, { TrackerEditor } from './components/TrackerForm';
import { GameDetailsPage } from './components/GameDetails';
import AuthScreen from './components/AuthScreen';
import Account from './components/Account';
import ConnectionCheck from './components/ConnectionCheck';
import { EmptyState } from './components/Ui';
import { Button } from './components/ui/button';
import { Field, FieldGroup, FieldLabel } from './components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from './components/ui/native-select';

function AppContent({
  repository,
  onScenario,
  api = false,
  emailLink,
  clearLink,
}: {
  repository?: TrackerRepository;
  onScenario?: (scenario: SampleScenario) => void;
  api?: boolean;
  emailLink?: EmailLink;
  clearLink(): void;
}) {
  const location = useLocation();
  const session = useApiSession()?.session;
  const [scenario, setScenario] = useState<SampleScenario>('normal');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (
      emailLink &&
      !(
        emailLink.page === 'verify'
          ? ['/verify', '/verify-email']
          : ['/reset', '/reset-password']
      ).includes(location.pathname)
    )
      clearLink();
  }, [emailLink, location.pathname, clearLink]);
  useEffect(() => {
    const title = document.querySelector<HTMLHeadingElement>('main h1');
    (title ?? document.querySelector<HTMLElement>('main'))?.focus({
      preventScroll: true,
    });
    document.title = `${title?.textContent ?? 'Price Tracker'} / Price Tracker${api ? '' : ' sample'}`;
  }, [location.pathname, api, session]);
  const privateView = (
    render: (repository: TrackerRepository) => React.ReactNode,
  ) => (api ? <PrivateView render={render} /> : render(repository!));
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <div className="sample-disclosure">
        <div className="shell">
          <strong>{api ? 'API mode' : 'Sample mode'}</strong>
          <span>
            {api
              ? 'Connected data only. Availability and delivery depend on the shared service.'
              : 'Not live. Changes reset on refresh. No real accounts or alerts.'}
          </span>
        </div>
      </div>
      <main id="main" className="shell main-content" tabIndex={-1}>
        <Routes key={`${location.pathname}:${revision}`}>
          <Route path="/" element={<Home />} />
          <Route
            path="/watchlist"
            element={privateView((repository) => (
              <Watchlist repository={repository} />
            ))}
          />
          <Route
            path="/add"
            element={privateView((repository) => (
              <TrackerForm repository={repository} />
            ))}
          />
          <Route
            path="/watchlist/:id"
            element={privateView((repository) => (
              <GameDetailsPage repository={repository} />
            ))}
          />
          <Route
            path="/watchlist/:id/edit"
            element={privateView((repository) => (
              <TrackerEditor repository={repository} />
            ))}
          />
          {(['login', 'register', 'verify', 'forgot', 'reset'] as const).map(
            (page) => (
              <Route
                key={page}
                path={`/${page}`}
                element={
                  api ? (
                    <ApiAuthScreen
                      key={page}
                      page={page}
                      emailLink={emailLink}
                      clearLink={clearLink}
                    />
                  ) : (
                    <AuthScreen key={page} page={page} />
                  )
                }
              />
            ),
          )}
          <Route
            path="/verify-email"
            element={
              api ? (
                <ApiAuthScreen
                  page="verify"
                  emailLink={emailLink}
                  clearLink={clearLink}
                />
              ) : (
                <AuthScreen page="verify" />
              )
            }
          />
          <Route
            path="/reset-password"
            element={
              api ? (
                <ApiAuthScreen
                  page="reset"
                  emailLink={emailLink}
                  clearLink={clearLink}
                />
              ) : (
                <AuthScreen page="reset" />
              )
            }
          />
          <Route
            path="/account"
            element={
              api ? <PrivateView render={() => <Account />} /> : <Account />
            }
          />
          <Route
            path="*"
            element={
              <EmptyState
                title="This page isn’t on the list"
                description={`The link may be out of date. Open your ${api ? '' : 'sample '}watchlist to continue.`}
              >
                <Button asChild>
                  <Link to="/watchlist">Open watchlist</Link>
                </Button>
              </EmptyState>
            }
          />
        </Routes>
      </main>
      <footer className="shell site-footer">
        <div className="footer-main">
          <Link to="/" className="footer-brand">
            price tracker.
          </Link>
          <p>
            Steam base games. US / USD.
            <br />
            Price data attributed to{' '}
            <a
              href="https://www.cheapshark.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              CheapShark
            </a>
            . Not affiliated with Steam.
          </p>
        </div>
        <details className="developer-tools">
          <summary>Development tools</summary>
          <div className="developer-content">
            {onScenario ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="scenario">Sample scenario</FieldLabel>
                  <NativeSelect
                    id="scenario"
                    value={scenario}
                    onChange={(event) => {
                      const value = event.target.value as SampleScenario;
                      setScenario(value);
                      onScenario(value);
                      setRevision((value) => value + 1);
                    }}
                  >
                    {sampleScenarios.map((value) => (
                      <NativeSelectOption key={value} value={value}>
                        {value === 'normal'
                          ? 'Normal'
                          : value.replaceAll('-', ' ')}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </FieldGroup>
            ) : null}
            {!api ? (
              <p>
                Scenario controls change local fixtures only. Use Add game for
                rejected-content previews. Refresh to restore the sample.
              </p>
            ) : null}
            <details>
              <summary>API connection (manual diagnostic)</summary>
              <ConnectionCheck />
            </details>
          </div>
        </details>
      </footer>
    </div>
  );
}
export default function App({
  repository,
  runtime: suppliedRuntime,
  emailLink: initialEmailLink,
}: {
  repository?: TrackerRepository;
  runtime?: Runtime;
  emailLink?: EmailLink;
}) {
  const [runtime] = useState(
    () =>
      suppliedRuntime ??
      (repository
        ? { mode: 'sample' as const, repository }
        : createRuntime()),
  );
  const [emailLink, setEmailLink] = useState(initialEmailLink);
  const clearLink = useCallback(() => setEmailLink(undefined), []);
  if (runtime.mode === 'invalid')
    return (
      <main className="shell main-content">
        <h1>Configuration error</h1>
        <p role="alert">{runtime.message}</p>
      </main>
    );
  const api = runtime.mode === 'api';
  const content = (
    <AppContent
      repository={runtime.mode === 'sample' ? runtime.repository : undefined}
      onScenario={runtime.mode === 'sample' ? runtime.onScenario : undefined}
      api={api}
      emailLink={emailLink}
      clearLink={clearLink}
    />
  );
  return (
    <BrowserRouter>
      <ApiModeContext.Provider value={api}>
        {runtime.mode === 'api' ? (
          <ApiSession client={runtime.client}>{content}</ApiSession>
        ) : (
          content
        )}
      </ApiModeContext.Provider>
    </BrowserRouter>
  );
}
