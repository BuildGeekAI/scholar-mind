import React, { useEffect, useState } from 'react';
import { Loader2, LogIn, MailCheck } from 'lucide-react';
import * as api from '../services/api';
import * as firebase from '../services/firebase';
import Footer from './Footer';

/**
 * Email and password sign-in, against Firebase.
 *
 * Firebase owns passwords, resets and lockout; this form's only jobs are to
 * collect credentials, hand the resulting ID token to our server for a session,
 * and be honest about what went wrong.
 *
 * A newly registered address is always unverified, so registration ends at
 * "check your inbox" rather than signed in — anyone can claim any address, and
 * an unverified one matching an allowed domain would otherwise reach that
 * domain's libraries.
 */

type Mode = 'signin' | 'signup';

const SignIn: React.FC = () => {
  const [config, setConfig] = useState<api.AuthConfig | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.authConfig().then(setConfig).catch(() => setConfig({ firebase: false, projectId: '', apiKey: '' }));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config?.apiKey || busy) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === 'signup') {
        const created = await firebase.signUp(config.apiKey, email, password);
        await firebase.sendVerificationEmail(config.apiKey, created.idToken).catch(() => {
          // The account exists either way; they can ask for another link below.
        });
        setNotice(
          `Account created. We have sent a confirmation link to ${email} — open it, then sign in.`
        );
        setMode('signin');
        setPassword('');
        return;
      }

      const session = await firebase.signIn(config.apiKey, email, password);
      // The server is the one that decides: it re-verifies the token, checks the
      // address is confirmed, and applies the domain policy.
      await api.exchangeFirebaseToken(session.idToken);
      window.location.href = '/';
    } catch (e: any) {
      if (e?.data?.reason === 'unverified') {
        setError(e.message);
        setNotice('Not received it? Sign in again to have another link sent.');
      } else {
        setError(e.message || 'Sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!config?.apiKey || !email.trim()) {
      setError('Enter your email address first, then ask for a reset.');
      return;
    }
    setError(null);
    try {
      await firebase.sendPasswordReset(config.apiKey, email);
    } catch {
      // Deliberately swallowed: telling someone the address is unknown turns
      // this into a way to find out who has an account.
    }
    setNotice(`If there is an account for ${email}, a reset link is on its way.`);
  };

  const field =
    'w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-scholarly-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

  if (!config) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="h-5 w-5 animate-spin text-scholarly-600" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-4 text-4xl" aria-hidden>📚</div>
          <h1 className="font-serif text-3xl text-slate-900 dark:text-slate-100">ScholarMind</h1>
          <p className="mt-1 text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500">
            Read a scholar's work, and ask it questions
          </p>
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            {mode === 'signin' ? 'Sign in to reach your libraries.' : 'Create an account.'}
          </p>
        </div>

        {!config.firebase ? (
          <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            Sign-in is not configured on this server. Set{' '}
            <code className="font-mono text-xs">FIREBASE_PROJECT_ID</code> and{' '}
            <code className="font-mono text-xs">FIREBASE_WEB_API_KEY</code>, then restart.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {notice && (
              <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
                <MailCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {notice}
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                {error}
              </p>
            )}

            <div>
              <label htmlFor="email" className="sr-only">Email address</label>
              <input
                id="email" type="email" autoComplete="email" required
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" disabled={busy} className={field}
              />
            </div>

            <div>
              <label htmlFor="password" className="sr-only">Password</label>
              <input
                id="password" type="password" required
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'Choose a password' : 'Password'}
                disabled={busy} className={field}
              />
            </div>

            <button
              type="submit" disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>

            <div className="flex items-center justify-between pt-1 text-xs text-slate-500 dark:text-slate-400">
              <button
                type="button"
                onClick={() => { setMode(m => (m === 'signin' ? 'signup' : 'signin')); setError(null); setNotice(null); }}
                className="underline"
              >
                {mode === 'signin' ? 'Create an account' : 'I already have an account'}
              </button>
              {mode === 'signin' && (
                <button type="button" onClick={resetPassword} className="underline">
                  Forgot password
                </button>
              )}
            </div>
          </form>
        )}
      </div>
      <div className="w-full max-w-sm">
        <Footer />
      </div>
    </div>
  );
};

export default SignIn;
