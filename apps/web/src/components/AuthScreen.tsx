import { useState, type SubmitEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Status } from './Ui';

type AuthPage = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
const titles = {
  login: 'Welcome back.',
  register: 'Make a little list.',
  verify: 'Check your inbox.',
  forgot: 'Forgot your password?',
  reset: 'Choose a new password.',
};
const descriptions = {
  login: 'An account-flow preview, not a real sign-in.',
  register: 'Preview an account for your next good game.',
  verify: 'Verification happens in the browser, before sign-in.',
  forgot: 'Preview the email reset flow. No message will be sent.',
  reset: 'A browser preview of the final reset step.',
};
export default function AuthScreen({ page }: { page: AuthPage }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState('sample-only');
  const [confirmation, setConfirmation] = useState('sample-only');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const [scenario, setScenario] = useState('normal');
  const needsPassword =
    page === 'login' || page === 'register' || page === 'reset';
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (scenario === 'expired') {
      setError(
        'Expired-link preview. Request a new link before continuing. No real token was read.',
      );
      return;
    }
    if (page === 'login' && scenario === 'unverified') {
      setError(
        'Unverified-account preview. Verify your email before signing in.',
      );
      return;
    }
    if (needsPassword && password.length < 8) {
      setError(
        'Use at least 8 characters for this sample password. Do not use a real password.',
      );
      return;
    }
    if (
      (page === 'register' || page === 'reset') &&
      password !== confirmation
    ) {
      setError('The sample passwords do not match.');
      return;
    }
    setPassword('');
    setConfirmation('');
    if (page === 'register') navigate('/verify');
    else if (page === 'login')
      navigate('/account', { state: { preview: true } });
    else {
      setComplete(true);
      setMessage(
        page === 'forgot'
          ? 'Reset-request preview complete. A real service would respond the same way whether an account exists or not. No email was sent.'
          : page === 'reset'
            ? 'Password-reset preview complete. No password was saved and you are not signed in.'
            : 'Verification-result preview: email verified. No real account was changed and you are not signed in.',
      );
    }
  }
  return (
    <section className="auth-page" aria-labelledby="auth-title">
      <div className="auth-intro">
        <h1 id="auth-title" tabIndex={-1}>
          {titles[page]}
        </h1>
        <p>{descriptions[page]}</p>
      </div>
      <div className="auth-surface">
        <p className="auth-disclosure">
          Sample fields only. Don’t enter real credentials. Nothing is stored or
          transmitted.
        </p>
        {location.state?.signedOut ? (
          <div className="mb-5">
            <Status>
              Signed-out preview. There was no real session to end.
            </Status>
          </div>
        ) : null}
        {page === 'verify' ? (
          <div className="verify-intro">
            <MailCheck aria-hidden="true" />
            <p>
              In the connected service, a verification link would go to your
              email. Open it in this browser, verify, then sign in. Android
              users return to the app to sign in.
            </p>
          </div>
        ) : null}
        {!complete ? (
          <form onSubmit={submit}>
            <FieldGroup>
              {page !== 'verify' && page !== 'reset' ? (
                <Field>
                  <FieldLabel htmlFor="sample-email">Sample email</FieldLabel>
                  <Input
                    id="sample-email"
                    type="email"
                    value="player@example.test"
                    readOnly
                    autoComplete="off"
                  />
                  <FieldDescription>
                    Fixed example address; no mailbox is used.
                  </FieldDescription>
                </Field>
              ) : null}
              {needsPassword ? (
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="sample-password">
                    {page === 'reset'
                      ? 'New sample password'
                      : 'Sample password'}
                  </FieldLabel>
                  <Input
                    id="sample-password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby="password-help"
                  />
                  <FieldDescription id="password-help">
                    Use made-up text only, at least 8 characters.
                  </FieldDescription>
                </Field>
              ) : null}
              {page === 'register' || page === 'reset' ? (
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="sample-confirm">
                    Confirm sample password
                  </FieldLabel>
                  <Input
                    id="sample-confirm"
                    type="password"
                    autoComplete="off"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    aria-invalid={Boolean(error)}
                  />
                </Field>
              ) : null}
              {error ? (
                <Status error>
                  {error}
                  {scenario === 'unverified' ? (
                    <Link to="/verify" className="text-link">
                      Preview email verification
                    </Link>
                  ) : scenario === 'expired' ? (
                    <Link
                      to={page === 'verify' ? '/register' : '/forgot'}
                      className="text-link"
                    >
                      Request a new link (preview)
                    </Link>
                  ) : null}
                </Status>
              ) : null}
              <Button type="submit">
                {page === 'login'
                  ? 'Preview sign in'
                  : page === 'register'
                    ? 'Preview registration'
                    : page === 'verify'
                      ? 'Preview successful verification'
                      : page === 'forgot'
                        ? 'Preview reset request'
                        : 'Preview password reset'}
              </Button>
            </FieldGroup>
          </form>
        ) : null}
        {message ? (
          <div className="mt-5">
            <Status>{message}</Status>
          </div>
        ) : null}
        {page === 'verify' && !complete ? (
          <Button
            className="mt-3"
            variant="outline"
            onClick={() =>
              setMessage('Resend preview only. No verification email was sent.')
            }
          >
            Preview resend email
          </Button>
        ) : null}
        <div className="auth-links">
          {page === 'login' ? (
            <>
              <Link to="/forgot">Forgot password?</Link>
              <Link to="/register">Preview registration</Link>
            </>
          ) : page === 'forgot' && complete ? (
            <Link to="/reset">Preview reset screen</Link>
          ) : (
            <Link to="/login">Back to sign in</Link>
          )}
          <Link to="/watchlist">Try sample without signing in</Link>
        </div>
      </div>
      <details className="auth-scenarios">
        <summary>Account preview scenarios</summary>
        <FieldGroup className="mt-4">
          <Field>
            <FieldLabel htmlFor="auth-scenario">Account scenario</FieldLabel>
            <NativeSelect
              id="auth-scenario"
              value={scenario}
              onChange={(event) => {
                setScenario(event.target.value);
                setError('');
                setComplete(false);
                setMessage('');
                setPassword('sample-only');
                setConfirmation('sample-only');
              }}
            >
              <NativeSelectOption value="normal">Normal</NativeSelectOption>
              {page === 'login' ? (
                <NativeSelectOption value="unverified">
                  Unverified account
                </NativeSelectOption>
              ) : null}
              {page === 'verify' || page === 'reset' ? (
                <NativeSelectOption value="expired">
                  Expired link
                </NativeSelectOption>
              ) : null}
            </NativeSelect>
          </Field>
        </FieldGroup>
      </details>
    </section>
  );
}
