import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Check,
  Loader2,
  MessageSquareQuote,
  Quote,
  Search,
  Share2,
  Sparkles,
  UserRoundCog,
} from 'lucide-react';
import * as api from '../services/api';
import * as firebase from '../services/firebase';
import Footer from './Footer';

/**
 * The first thing anyone sees, and for a while the only thing.
 *
 * It was a bare form on an empty page: someone arriving had no way to learn what
 * this is before being asked to make an account. So the page explains itself,
 * and the form travels alongside rather than being somewhere else — sticky on
 * desktop, first thing after the pitch on mobile.
 */

type Mode = 'signin' | 'signup';

const STEPS = [
  {
    title: 'Name a scholar',
    body: 'A name or a Google Scholar link. Their published work is found, resolved to open-access sources where they exist, and queued.',
  },
  {
    title: 'It reads, in the background',
    body: 'Downloading, extracting and indexing happen on a queue, not in your browser. Close the tab; progress is waiting when you return.',
  },
  {
    title: 'Ask',
    body: 'One library, everything you can reach, or a scholar’s work answering in their own register. Every answer shows the passages behind it.',
  },
];

const FEATURES = [
  {
    tint: 'bg-scholarly-50 text-scholarly-600 dark:bg-scholarly-500/15 dark:text-scholarly-400',
    icon: BookOpen,
    title: 'Libraries that build themselves',
    body: 'Papers, and anything else — PDFs, your own notes, web pages, Wikipedia, a conference talk on YouTube. A video is watched once and transcribed, however often you use it.',
  },
  {
    tint: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
    icon: MessageSquareQuote,
    title: 'Answers you can check',
    body: 'Every claim points at the passage it came from. Citations are the text actually retrieved, never something the model reported afterwards.',
  },
  {
    tint: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400',
    icon: UserRoundCog,
    title: 'Advisors',
    body: 'Turn a library into someone you can consult. It answers from their published work in their register — and says so plainly when their work does not cover your question, rather than inventing a position.',
  },
  {
    tint: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
    icon: Search,
    title: 'Search across everything',
    body: 'One query over every library you can reach, returning the passage that matched rather than a list of titles.',
  },
  {
    tint: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400',
    icon: Share2,
    title: 'Shared, deliberately',
    body: 'A library is yours, your team’s, or your organisation’s — or shared with named people as a viewer or an editor. Build an advisor once; everyone consults the same one.',
  },
  {
    tint: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400',
    icon: Sparkles,
    title: 'Read it back',
    body: 'A write-up, slides, flashcards, a quiz, narration and cover art for any source. Bibliographies in BibTeX, APA, MLA, Chicago, Harvard or RIS.',
  },
];

const SignIn: React.FC = () => {
  const [config, setConfig] = useState<api.AuthConfig | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.authConfig()
      .then(setConfig)
      .catch(() => setConfig({ firebase: false, projectId: '', apiKey: '' }));
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
        await firebase.sendVerificationEmail(config.apiKey, created.idToken).catch(() => {});
        setNotice(`Account created. Open the confirmation link we sent to ${email}, then sign in.`);
        setMode('signin');
        setPassword('');
        return;
      }

      const session = await firebase.signIn(config.apiKey, email, password);
      await api.exchangeFirebaseToken(session.idToken);
      window.location.href = '/';
    } catch (e: any) {
      if (e?.data?.reason === 'unverified') {
        setError(e.message);
        setNotice('Not arrived? Sign in again to have another link sent.');
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
      // Swallowed on purpose: saying the address is unknown turns this into a
      // way to find out who has an account.
    }
    setNotice(`If there is an account for ${email}, a reset link is on its way.`);
  };

  const field =
    'w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-ink outline-none transition focus:border-scholarly-500 disabled:opacity-60';

  if (!config) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <Loader2 className="h-5 w-5 animate-spin text-scholarly-600" aria-label="Loading" />
      </div>
    );
  }

  const form = (
    <div className="rounded-2xl border border-line bg-panel p-6 shadow-xl shadow-black/5 dark:shadow-black/40">
      <h2 className="font-serif text-lg text-ink">
        {mode === 'signin' ? 'Sign in' : 'Create an account'}
      </h2>
      <p className="mt-1 text-xs text-muted">
        {mode === 'signin'
          ? 'Reach your libraries and the ones shared with you.'
          : 'We will send a link to confirm your address.'}
      </p>

      {!config.firebase ? (
        <p className="mt-4 rounded-lg bg-panel-2 px-4 py-3 text-sm text-muted">
          Sign-in is not configured on this server. Set{' '}
          <code className="font-mono text-xs">FIREBASE_PROJECT_ID</code> and{' '}
          <code className="font-mono text-xs">FIREBASE_WEB_API_KEY</code>, then restart.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-5 space-y-3">
          {notice && (
            <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
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
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-scholarly-500 to-scholarly-700 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-scholarly-500/25 transition hover:opacity-95 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <div className="flex items-center justify-between pt-1 text-xs text-muted">
            <button
              type="button"
              onClick={() => { setMode(m => (m === 'signin' ? 'signup' : 'signin')); setError(null); setNotice(null); }}
              className="underline hover:text-ink transition-colors"
            >
              {mode === 'signin' ? 'Create an account' : 'I already have one'}
            </button>
            {mode === 'signin' && (
              <button type="button" onClick={resetPassword} className="underline hover:text-ink transition-colors">
                Forgot password
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-surface">
      {/* A wash behind the fold, so the page has depth without decoration. */}
      <div className="relative overflow-hidden bg-gradient-to-br from-scholarly-50 via-surface to-violet-50/40 dark:from-scholarly-500/10 dark:via-surface dark:to-violet-500/5">
        {/* Two soft washes rather than a flat tint, so the hero has depth
            without anything competing with the text on top of it. */}
        <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-scholarly-400/20 blur-3xl dark:bg-scholarly-500/10" aria-hidden />
        <div className="pointer-events-none absolute -right-20 top-40 h-80 w-80 rounded-full bg-violet-400/15 blur-3xl dark:bg-violet-500/10" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-6 pt-10">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-gradient-to-br from-scholarly-500 to-scholarly-700 p-2.5 shadow-lg shadow-scholarly-500/25">
              <BookOpen className="h-5 w-5 text-white" aria-hidden />
            </div>
            <span className="font-serif text-lg text-ink">ScholarMind</span>
          </div>

          <div className="grid gap-12 pb-16 pt-14 lg:grid-cols-[1.15fr_minmax(320px,1fr)] lg:gap-16">
            <div>
              <h1 className="max-w-2xl font-serif text-4xl leading-[1.15] text-ink sm:text-5xl">
                Read a scholar’s work.
                <br />
                <span className="text-scholarly-600 dark:text-scholarly-400">Then ask it questions.</span>
              </h1>

              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                Point it at a researcher and it assembles their published work into a library you can
                interrogate — grounded in what they actually wrote, with the passage behind every
                answer.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-subtle">
                <span className="inline-flex items-center gap-1.5">
                  <Quote className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> Citations from the source, not the model
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Share2 className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" aria-hidden /> Shared across a team
                </span>
              </div>
            </div>

            {/* Sticky on desktop: readable at any scroll depth, without a
                separate page or a jump link. */}
            <div className="lg:sticky lg:top-10 lg:self-start">{form}</div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6">
        <section className="border-t border-line py-16">
          <h2 className="font-serif text-2xl text-ink">How it works</h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-scholarly-500 to-scholarly-700 font-serif text-sm text-white shadow-md shadow-scholarly-500/25">
                  {i + 1}
                </span>
                <h3 className="mt-3 font-medium text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-line py-16">
          <h2 className="font-serif text-2xl text-ink">What it does</h2>
          <div className="mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, tint, title, body }) => (
              <div key={title} className="flex gap-4">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tint}`}>
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <div>
                  <h3 className="font-medium text-ink">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* The claim worth making explicitly, because it is the one that
            separates this from a chatbot with a search box. */}
        <section className="border-t border-line py-16">
          <blockquote className="max-w-3xl rounded-2xl border border-scholarly-200/60 bg-gradient-to-br from-scholarly-50 to-violet-50/50 p-8 dark:border-scholarly-500/20 dark:from-scholarly-500/10 dark:to-violet-500/5">
            <p className="font-serif text-xl leading-relaxed text-ink sm:text-2xl">
              An advisor whose work does not cover your question will tell you so.
            </p>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
              Not as a disclaimer — as a mechanism. When nothing relevant is found in a scholar’s
              indexed work, the model is not asked at all, so there is nothing there to invent an
              answer from. What you get back is either grounded in something you can read, or an
              admission that it is not there.
            </p>
          </blockquote>
        </section>

        <Footer />
      </div>
    </div>
  );
};

export default SignIn;
