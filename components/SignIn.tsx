import React from 'react';
import { LogIn } from 'lucide-react';
import * as api from '../services/api';

/**
 * Shown when the server does not recognise the caller.
 *
 * Sign-in is a full-page navigation rather than a fetch: OAuth is a redirect
 * flow, and the session arrives as a cookie set on the callback.
 */

const REASONS: Record<string, string> = {
  denied: 'Sign-in was cancelled.',
  state: 'That sign-in link expired or was already used. Please try again.',
  failed: 'Google could not verify that sign-in. Please try again.',
  domain: 'That account is not permitted to sign in here.',
};

interface Props {
  /** False when the server has no OAuth client configured. */
  googleReady: boolean;
}

const SignIn: React.FC<Props> = ({ googleReady }) => {
  // The callback reports outcomes through the query string, since it has no
  // other way to say anything to a page it is redirecting to.
  const reason = new URLSearchParams(window.location.search).get('auth');
  const message = reason ? REASONS[reason] ?? 'Sign-in did not complete.' : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 dark:bg-slate-950">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8">
          <div className="mx-auto mb-4 text-4xl">📚</div>
          <h1 className="font-serif text-2xl text-slate-900 dark:text-slate-100">ScholarMind</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Sign in to reach your libraries.
          </p>
        </div>

        {message && (
          <p
            role="alert"
            className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
          >
            {message}
          </p>
        )}

        {googleReady ? (
          <button
            type="button"
            onClick={api.signInWithGoogle}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            <LogIn className="h-4 w-4" aria-hidden />
            Continue with Google
          </button>
        ) : (
          <p className="rounded-lg bg-slate-100 px-4 py-3 text-left text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            Google sign-in is not configured on this server. Set{' '}
            <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_ID</code> and{' '}
            <code className="font-mono text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code>, then restart.
          </p>
        )}
      </div>
    </div>
  );
};

export default SignIn;
