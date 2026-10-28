import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApiSession, isAborted } from '../client/sessionContext';
import type { EmailLink } from '../client/runtime';
import { ClientError } from '../client/http';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel, FieldSet, FieldDescription } from './ui/field';
import { Input } from './ui/input';
import { Status } from './Ui';
import { RequestError } from './RequestError';
import { useRetryWait } from '../data/useRetryWait';

export type AuthPage = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
const titles = { login: 'Welcome back.', register: 'Make a little list.', verify: 'Verify your email.', forgot: 'Forgot your password?', reset: 'Choose a new password.' };
export default function ApiAuthScreen({ page, emailLink, clearLink }: { page: AuthPage; emailLink?: EmailLink; clearLink(): void }) {
  const { client } = useApiSession()!;
  const navigate = useNavigate();
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const [complete, setComplete] = useState(false);
  const wait = useRetryWait(error);
  const token = emailLink?.page === page ? emailLink.token : null;
  const needsPassword = ['login', 'register', 'reset'].includes(page);
  async function submit(event: SubmitEvent<HTMLFormElement>, resend = false) {
    event.preventDefault();
    if (busy || wait) return;
    setError(undefined); setMessage('');
    if (!resend && (page === 'register' || page === 'reset') && password !== confirmation) { setError(new Error('The passwords do not match.')); return; }
    if (!resend && (page === 'verify' || page === 'reset') && !token) { setError(new Error('This link is missing or invalid. Request a new email link.')); return; }
    const current = new AbortController(); controller.current = current;
    const options = { signal: current.signal };
    setBusy(true);
    try {
      let result: { message: string } | undefined;
      if (resend) result = await client.resendVerification(email, options);
      else if (page === 'login') { await client.login({ email, password }, options); if (active.current) navigate('/watchlist', { replace: true }); }
      else if (page === 'register') result = await client.register({ email, password, ...(name ? { name } : {}) }, options);
      else if (page === 'forgot') result = await client.forgotPassword(email, options);
      else if (page === 'verify') await client.verifyEmail(token!, options);
      else await client.resetPassword(token!, password, options);
      if (!active.current) return;
      setPassword(''); setConfirmation('');
      if (resend) setMessage(result!.message);
      else {
        setComplete(page !== 'login');
        setMessage(result?.message ?? (page === 'verify' ? 'Email verified. Sign in separately, or return to Android and sign in.' : 'Password reset. All sessions were revoked. Sign in separately.'));
        if (page === 'verify' || page === 'reset') clearLink();
      }
    } catch (error) { if (active.current && !isAborted(error)) setError(error); }
    finally { if (active.current) setBusy(false); }
  }
  return <section className="auth-page" aria-labelledby="auth-title">
    <div className="auth-intro"><h1 id="auth-title" tabIndex={-1}>{titles[page]}</h1><p>Connected account service. Verification and password reset do not sign you in.</p></div>
    <div className="auth-surface">
      {!complete ? <form onSubmit={(event) => void submit(event)}><FieldSet disabled={busy || wait > 0} aria-busy={busy}><FieldGroup>
        {page !== 'reset' ? <Field><FieldLabel htmlFor="email">Email</FieldLabel><Input id="email" type="email" autoComplete="email" required={page !== 'verify' || !token} value={email} onChange={(e) => setEmail(e.target.value)} /></Field> : null}
        {page === 'register' ? <Field><FieldLabel htmlFor="name">Name (optional)</FieldLabel><Input id="name" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field> : null}
        {needsPassword ? <Field><FieldLabel htmlFor="password">{page === 'reset' ? 'New password' : 'Password'}</FieldLabel><Input id="password" type="password" autoComplete={page === 'login' ? 'current-password' : 'new-password'} minLength={page === 'login' ? 1 : 12} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} /><FieldDescription>{page === 'login' ? 'Use your verified account password.' : 'Use 12–128 characters. Passwords are never trimmed.'}</FieldDescription></Field> : null}
        {page === 'register' || page === 'reset' ? <Field><FieldLabel htmlFor="confirmation">Confirm password</FieldLabel><Input id="confirmation" type="password" autoComplete="new-password" required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field> : null}
        {page === 'verify' ? <p>{token ? 'The email link is ready. Confirm explicitly to verify your email.' : 'Open the verification link from your email. You can request another below.'}</p> : null}
        {page === 'reset' && !token ? <p>This reset link is missing. Request a new reset email.</p> : null}
        <Button type="submit" disabled={(page === 'verify' || page === 'reset') && !token}>{busy ? 'Working…' : page === 'login' ? 'Sign in' : page === 'register' ? 'Create account' : page === 'verify' ? 'Verify email' : page === 'forgot' ? 'Send reset email' : 'Reset password'}</Button>
      </FieldGroup></FieldSet></form> : null}
      {page === 'verify' && !complete ? <form className="mt-4" onSubmit={(e) => void submit(e, true)}><Button variant="outline" disabled={busy || wait > 0 || !email} type="submit">Resend verification email</Button></form> : null}
      {error ? <div className="mt-5"><Status error><RequestError error={error} />{error instanceof ClientError && error.details.code === 'EMAIL_UNVERIFIED' ? <Link className="text-link" to="/verify">Verify or resend email</Link> : null}</Status></div> : null}
      {wait ? <p role="status">Retry available in {wait} seconds.</p> : null}
      {message ? <div className="mt-5"><Status>{message}</Status></div> : null}
      <div className="auth-links"><Link to="/login">Back to sign in</Link><Link to="/register">Create account</Link><Link to="/forgot">Request password reset</Link><Link to="/watchlist">Open watchlist</Link></div>
    </div>
  </section>;
}
