import React, { useState } from 'react';
import type { Page } from '../types/Navigation';
import { Btn, Field, Panel, Status } from './Ui';

export default function AuthScreen({
  page,
  navigate,
}: {
  page: Page;
  navigate: (page: Page) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');

  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    // These forms preview the account flow; they do not create a real session.
    event.preventDefault();
    if ((page === 'register' || page === 'reset') && password !== confirm) {
      setMessage('Passwords do not match.');
      return;
    }
    if ((page === 'register' || page === 'reset') && password.length < 8) {
      setMessage('For this prototype, use at least 8 characters.');
      return;
    }
    if (page === 'register') {
      setMessage('');
      navigate('verify');
      return;
    }
    if (page === 'login') {
      setMessage('');
      navigate('watchlist');
      return;
    }
    if (page === 'forgot') {
      setMessage('Mock request accepted; no reset email was sent.');
      return;
    }
    if (page === 'reset') {
      setMessage('Mock reset completed; no password was changed.');
      return;
    }
    setMessage('Mock verification completed; no token was checked.');
  }

  const title: Record<string, string> = {
    login: 'Sign in',
    register: 'Create account',
    verify: 'Verify email',
    forgot: 'Forgot password',
    reset: 'Reset password',
  };
  return (
    <main className="mx-auto max-w-lg px-4 py-10 sm:py-16">
      <h1 className="mb-3 text-3xl font-bold">{title[page]}</h1>
      <div className="mb-6">
        <Status>
          Frontend preview only. Registration, email delivery, verification, and
          sessions are not connected to a backend.
        </Status>
      </div>
      <Panel title={title[page] ?? 'Sign in'}>
        <form key={page} onSubmit={submit} className="space-y-4">
          {(page === 'login' || page === 'register' || page === 'forgot') && (
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
            />
          )}
          {(page === 'login' || page === 'register' || page === 'reset') && (
            <Field
              label={page === 'reset' ? 'New password' : 'Password'}
              type="password"
              value={password}
              onChange={setPassword}
            />
          )}
          {(page === 'register' || page === 'reset') && (
            <Field
              label="Confirm password"
              type="password"
              value={confirm}
              onChange={setConfirm}
            />
          )}
          {page === 'verify' && (
            <Field
              label="Verification code"
              value={confirm}
              onChange={setConfirm}
              placeholder="Example: 123456"
            />
          )}
          {message && (
            <Status
              tone={
                message.startsWith('Passwords') || message.startsWith('For')
                  ? 'error'
                  : 'info'
              }
            >
              {message}
            </Status>
          )}
          <Btn type="submit">
            {page === 'login'
              ? 'Preview sign-in'
              : page === 'register'
                ? 'Continue to verification'
                : page === 'verify'
                  ? 'Preview verification'
                  : page === 'forgot'
                    ? 'Request reset (mock)'
                    : 'Reset password (mock)'}
          </Btn>
        </form>
        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          {page !== 'login' && (
            <button
              className="text-teal-300 underline"
              onClick={() => navigate('login')}
            >
              Back to sign in
            </button>
          )}
          {page === 'login' && (
            <>
              <button
                className="text-teal-300 underline"
                onClick={() => navigate('register')}
              >
                Create account
              </button>
              <button
                className="text-teal-300 underline"
                onClick={() => navigate('forgot')}
              >
                Forgot password?
              </button>
            </>
          )}
          {page === 'forgot' && (
            <button
              className="text-teal-300 underline"
              onClick={() => navigate('reset')}
            >
              Preview reset page
            </button>
          )}
          {page === 'verify' && (
            <button
              className="text-teal-300 underline"
              onClick={() =>
                setMessage('Mock resend selected; no email was sent.')
              }
            >
              Resend code (mock)
            </button>
          )}
        </div>
      </Panel>
    </main>
  );
}
