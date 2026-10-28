import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import {
  createSampleRepository,
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
}: {
  repository: TrackerRepository;
  onScenario?: (scenario: SampleScenario) => void;
}) {
  const location = useLocation();
  const [scenario, setScenario] = useState<SampleScenario>('normal');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const title = document.querySelector<HTMLHeadingElement>('main h1');
    (title ?? document.querySelector<HTMLElement>('main'))?.focus({
      preventScroll: true,
    });
    document.title = `${title?.textContent ?? 'Price Tracker'} / Price Tracker sample`;
  }, [location.pathname]);
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <div className="sample-disclosure">
        <div className="shell">
          <strong>Sample mode</strong>
          <span>
            Not live. Changes reset on refresh. No real accounts or alerts.
          </span>
        </div>
      </div>
      <main id="main" className="shell main-content" tabIndex={-1}>
        <Routes key={`${location.pathname}:${revision}`}>
          <Route path="/" element={<Home />} />
          <Route
            path="/watchlist"
            element={<Watchlist repository={repository} />}
          />
          <Route
            path="/add"
            element={<TrackerForm repository={repository} />}
          />
          <Route
            path="/watchlist/:id"
            element={<GameDetailsPage repository={repository} />}
          />
          <Route
            path="/watchlist/:id/edit"
            element={<TrackerEditor repository={repository} />}
          />
          {(['login', 'register', 'verify', 'forgot', 'reset'] as const).map(
            (page) => (
              <Route
                key={page}
                path={`/${page}`}
                element={<AuthScreen key={page} page={page} />}
              />
            ),
          )}
          <Route path="/account" element={<Account />} />
          <Route
            path="*"
            element={
              <EmptyState
                title="This page isn’t on the list"
                description="The link may be out of date. Open your sample watchlist to continue."
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
            <p>
              Scenario controls change local fixtures only. Use Add game for
              rejected-content previews. Refresh to restore the sample.
            </p>
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
}: {
  repository?: TrackerRepository;
}) {
  const [sample] = useState(() => createSampleRepository());
  return (
    <BrowserRouter>
      <AppContent
        repository={repository ?? sample}
        onScenario={
          repository ? undefined : (scenario) => sample.setScenario(scenario)
        }
      />
    </BrowserRouter>
  );
}
