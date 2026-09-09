import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Library, Loader2, Search, Send, UserRoundCog } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Citation } from '../types';
import * as api from '../services/api';

/**
 * The landing page's question box.
 *
 * One input, and an explicit choice of *what it is asking* — because the four
 * possibilities answer differently and a user who cannot see which one they got
 * cannot tell a bad answer from a wrong target.
 *
 *  - **All libraries** — retrieval across everything you can reach, in one query.
 *    No cap: this used to be the five most recently touched libraries.
 *  - **One library** — File Search, which holds the papers' full text.
 *  - **An advisor** — the same retrieval, answered in that person's register.
 *  - **The web** — no library at all.
 */

type Target =
  | { kind: 'all' }
  | { kind: 'library'; id: string; title: string }
  | { kind: 'advisor'; id: string; title: string }
  | { kind: 'web' };

interface Props {
  libraries: api.ProfileRecord[];
  onOpenProfile: (id: string) => void;
  /** Nothing matched, so offer to build a library for the query instead. */
  onCreateFor: (query: string) => Promise<void>;
}

const AskPanel: React.FC<Props> = ({ libraries, onOpenProfile, onCreateFor }) => {
  const [question, setQuestion] = useState('');
  const [target, setTarget] = useState<Target>({ kind: 'all' });
  const [advisors, setAdvisors] = useState<api.Advisor[]>([]);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [searched, setSearched] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const answerRef = useRef('');

  useEffect(() => {
    api.listAdvisors().then(setAdvisors).catch(() => setAdvisors([]));
  }, []);

  const askedNothing = !busy && !answer && !error;

  const ask = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = question.trim();
      if (!q || busy) return;

      setBusy(true);
      setError(null);
      setAnswer('');
      setCitations([]);
      setSearched([]);
      answerRef.current = '';

      try {
        if (target.kind === 'advisor') {
          await api.consult(q, [target.id], {}, {
            onAdvisor: a => {
              setAnswer(a.answer);
              setCitations(
                a.citations.map(c => ({
                  fileName: c.paperTitle,
                  documentUri: '',
                  snippet: c.snippet,
                }))
              );
              setSearched([target.title]);
            },
            onError: setError,
          });
        } else {
          await api.streamChat(
            target.kind === 'library' ? target.id : null,
            q,
            target.kind === 'web',
            text => {
              answerRef.current += text;
              setAnswer(answerRef.current);
            },
            info => setSearched(info.searchedLibraries ?? []),
            setError,
            setCitations
          );
        }
      } catch (e: any) {
        setError(e.message || 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
    [question, target, busy]
  );

  const readyAdvisors = useMemo(() => advisors.filter(a => a.indexedCount > 0), [advisors]);

  const targetLabel =
    target.kind === 'all'
      ? 'All my libraries'
      : target.kind === 'web'
        ? 'The web'
        : target.title;

  const pill = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
      active
        ? 'bg-ink text-surface'
        : 'bg-panel-2 text-muted hover:text-ink'
    }`;

  return (
    <section className="mb-10">
      <form onSubmit={ask}>
        <div className="flex gap-2">
          <label htmlFor="ask" className="sr-only">
            Your question
          </label>
          <input
            id="ask"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={`Ask ${targetLabel.toLowerCase()}…`}
            disabled={busy}
            className="flex-1 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink outline-none focus:border-scholarly-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-medium text-surface transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Ask
          </button>
        </div>

        {/* The target is a visible choice, not an inference. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setTarget({ kind: 'all' })} className={pill(target.kind === 'all')}>
            <Library className="h-3.5 w-3.5" aria-hidden /> All my libraries
          </button>

          <label className="sr-only" htmlFor="pick-library">One library</label>
          <select
            id="pick-library"
            value={target.kind === 'library' ? target.id : ''}
            onChange={e => {
              const lib = libraries.find(l => l.id === e.target.value);
              setTarget(lib ? { kind: 'library', id: lib.id, title: lib.title } : { kind: 'all' });
            }}
            className={`${pill(target.kind === 'library')} appearance-none pr-6`}
          >
            <option value="">One library…</option>
            {libraries.map(l => (
              <option key={l.id} value={l.id}>{l.title}</option>
            ))}
          </select>

          {readyAdvisors.length > 0 && (
            <>
              <label className="sr-only" htmlFor="pick-advisor">An advisor</label>
              <select
                id="pick-advisor"
                value={target.kind === 'advisor' ? target.id : ''}
                onChange={e => {
                  const adv = readyAdvisors.find(a => a.id === e.target.value);
                  setTarget(
                    adv
                      ? { kind: 'advisor', id: adv.id, title: adv.advisorName || adv.title }
                      : { kind: 'all' }
                  );
                }}
                className={`${pill(target.kind === 'advisor')} appearance-none pr-6`}
              >
                <option value="">An advisor…</option>
                {readyAdvisors.map(a => (
                  <option key={a.id} value={a.id}>{a.advisorName || a.title}</option>
                ))}
              </select>
            </>
          )}

          <button type="button" onClick={() => setTarget({ kind: 'web' })} className={pill(target.kind === 'web')}>
            <Globe className="h-3.5 w-3.5" aria-hidden /> The web
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}

      {(busy || answer) && (
        <article className="mt-5 rounded-xl border border-line bg-panel p-5">
          <header className="mb-3 flex items-center gap-2 text-xs text-muted">
            {target.kind === 'web' ? (
              <Globe className="h-3.5 w-3.5" aria-hidden />
            ) : target.kind === 'advisor' ? (
              <UserRoundCog className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Search className="h-3.5 w-3.5" aria-hidden />
            )}
            {/* Which libraries actually answered, not which were asked. */}
            {searched.length ? `From ${searched.join(', ')}` : targetLabel}
          </header>

          {answer ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{answer}</ReactMarkdown>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Thinking…
            </p>
          )}

          {citations.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
              {citations.map((c, i) => (
                <li key={`${c.fileName}-${i}`} className="text-xs text-muted">
                  <span className="font-medium text-ink">{c.fileName}</span>
                  {c.snippet && <span className="ml-1 italic">“{c.snippet}”</span>}
                </li>
              ))}
            </ul>
          )}
        </article>
      )}

      {askedNothing && !libraries.length && (
        <p className="mt-4 text-sm text-muted">
          No libraries yet. Type a scholar's name and{' '}
          <button
            type="button"
            disabled={creating || !question.trim()}
            onClick={async () => {
              setCreating(true);
              try {
                await onCreateFor(question.trim());
              } finally {
                setCreating(false);
              }
            }}
            className="underline disabled:opacity-40"
          >
            {creating ? 'building…' : 'build one'}
          </button>
          .
        </p>
      )}
    </section>
  );
};

export default AskPanel;
