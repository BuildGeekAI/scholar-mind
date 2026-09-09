import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Library, Loader2, Quote, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Citation } from '../types';
import * as api from '../services/api';

/**
 * The question box, and everything you can point it at, on one page.
 *
 * Advisors used to live behind a button, on a gallery, leading to a third page
 * to actually ask anything. Consulting one was three navigations away from the
 * place you were already typing a question — and they were invisible until you
 * went looking, so nobody would know they existed.
 *
 * They belong here, visible, next to the other things a question can be aimed
 * at. Selecting more than one asks a panel.
 */

interface Answer {
  id: string;
  /** Advisor name, library name, or "The web". */
  from: string;
  text: string;
  citations: Citation[];
  abstained?: boolean;
}

interface Props {
  libraries: api.ProfileRecord[];
  onCreateFor: (query: string) => Promise<void>;
}

const AskPanel: React.FC<Props> = ({ libraries, onCreateFor }) => {
  const [question, setQuestion] = useState('');
  const [advisors, setAdvisors] = useState<api.Advisor[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [web, setWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const streamed = useRef('');

  useEffect(() => {
    api.listAdvisors().then(setAdvisors).catch(() => setAdvisors([]));
  }, []);

  const ready = useMemo(() => advisors.filter(a => a.indexedCount > 0), [advisors]);

  /** Picking advisors is the strongest signal, so it wins over the other targets. */
  const consulting = picked.size > 0;

  const target = consulting
    ? `${picked.size} advisor${picked.size === 1 ? '' : 's'}`
    : web
      ? 'the web'
      : libraryId
        ? libraries.find(l => l.id === libraryId)?.title ?? 'a library'
        : 'all my libraries';

  const toggleAdvisor = (id: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Asking an advisor and a library at once would mean two different
      // questions; the advisor selection takes over.
      if (next.size) { setWeb(false); setLibraryId(null); }
      return next;
    });

  const ask = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = question.trim();
      if (!q || busy) return;

      setBusy(true);
      setError(null);
      setAnswers([]);
      streamed.current = '';

      try {
        if (consulting) {
          // One card per advisor, appearing as each lands.
          await api.consult(q, [...picked], {}, {
            onAdvisor: a =>
              setAnswers(prev => [
                ...prev,
                {
                  id: a.profileId,
                  from: a.advisorName,
                  text: a.answer,
                  abstained: a.abstained,
                  citations: a.citations.map(c => ({
                    fileName: c.paperTitle,
                    documentUri: '',
                    snippet: c.snippet,
                  })),
                },
              ]),
            onError: setError,
          });
        } else {
          const from = web ? 'The web' : libraryId
            ? libraries.find(l => l.id === libraryId)?.title ?? 'Library'
            : 'Your libraries';
          setAnswers([{ id: 'chat', from, text: '', citations: [] }]);

          await api.streamChat(
            libraryId,
            q,
            web,
            text => {
              streamed.current += text;
              setAnswers(prev => [{ ...prev[0], text: streamed.current }]);
            },
            info =>
              setAnswers(prev => [
                {
                  ...prev[0],
                  // Which libraries actually contributed, not which were asked.
                  from: info.searchedLibraries?.length ? info.searchedLibraries.join(', ') : from,
                },
              ]),
            setError,
            cites => setAnswers(prev => [{ ...prev[0], citations: cites }])
          );
        }
      } catch (e: any) {
        setError(e.message || 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
    [question, busy, consulting, picked, web, libraryId, libraries]
  );

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
      active ? 'bg-ink text-surface' : 'bg-panel-2 text-muted hover:text-ink'
    }`;

  return (
    <section className="mb-10">
      <form onSubmit={ask}>
        <div className="flex gap-2">
          <label htmlFor="ask" className="sr-only">Your question</label>
          <input
            id="ask"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={`Ask ${target}…`}
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

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { setPicked(new Set()); setWeb(false); setLibraryId(null); }}
            className={chip(!consulting && !web && !libraryId)}
          >
            <Library className="h-3.5 w-3.5" aria-hidden /> All my libraries
          </button>

          {libraries.length > 0 && (
            <>
              <label className="sr-only" htmlFor="pick-library">One library</label>
              <select
                id="pick-library"
                value={libraryId ?? ''}
                onChange={e => {
                  setLibraryId(e.target.value || null);
                  if (e.target.value) { setWeb(false); setPicked(new Set()); }
                }}
                className={`${chip(!!libraryId)} appearance-none`}
              >
                <option value="">One library…</option>
                {libraries.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
              </select>
            </>
          )}

          <button
            type="button"
            onClick={() => { setWeb(true); setPicked(new Set()); setLibraryId(null); }}
            className={chip(web)}
          >
            <Globe className="h-3.5 w-3.5" aria-hidden /> The web
          </button>
        </div>

        {/* Advisors, visible rather than behind a button. */}
        {ready.length > 0 && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-subtle">or consult</span>
              {ready.map(advisor => {
                const name = advisor.advisorName || advisor.scholarName || advisor.title;
                const on = picked.has(advisor.id);
                return (
                  <button
                    key={advisor.id}
                    type="button"
                    onClick={() => toggleAdvisor(advisor.id)}
                    aria-pressed={on}
                    title={advisor.deepCount === 0 ? 'Abstracts only — answers will be shallow' : undefined}
                    className={`${chip(on)} ${advisor.deepCount === 0 ? 'ring-1 ring-amber-400/50' : ''}`}
                  >
                    <span aria-hidden>{advisor.emoji}</span>
                    {name}
                    {!advisor.mine && <span className="opacity-50">· shared</span>}
                  </button>
                );
              })}
            </div>
            {consulting && picked.size > 1 && (
              <p className="mt-2 text-xs text-subtle">
                Each answers from their own work, separately — so you can see where they differ.
              </p>
            )}
            {[...picked].some(id => ready.find(a => a.id === id)?.deepCount === 0) && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                One of these holds abstracts only. Run <span className="font-medium">Generate</span> on
                its sources for answers with substance.
              </p>
            )}
          </div>
        )}
      </form>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}

      {answers.length > 0 && (
        <div className="mt-5 space-y-4">
          {answers.map(a => (
            <article key={a.id} className="rounded-xl border border-line bg-panel p-5">
              <header className="mb-3 flex items-baseline justify-between gap-3 text-xs text-muted">
                <span className="font-medium text-ink">{a.from}</span>
                {consulting && <span className="shrink-0 text-subtle">from published work</span>}
              </header>

              {a.text ? (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown>{a.text}</ReactMarkdown>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Thinking…
                </p>
              )}

              {a.citations.length > 0 && (
                <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
                  {a.citations.map((c, i) => (
                    <li key={`${c.fileName}-${i}`} className="flex gap-1.5 text-xs text-muted">
                      <Quote className="mt-0.5 h-3 w-3 shrink-0 opacity-50" aria-hidden />
                      <span>
                        <span className="font-medium text-ink">{c.fileName}</span>
                        {c.snippet && <span className="ml-1 italic">“{c.snippet}”</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}

          {busy && consulting && answers.length < picked.size && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Waiting on {picked.size - answers.length} more…
            </p>
          )}
        </div>
      )}

      {!libraries.length && !busy && !answers.length && (
        <p className="mt-4 text-sm text-muted">
          No libraries yet. Type a scholar's name and{' '}
          <button
            type="button"
            disabled={creating || !question.trim()}
            onClick={async () => {
              setCreating(true);
              try { await onCreateFor(question.trim()); } finally { setCreating(false); }
            }}
            className="underline disabled:opacity-40"
          >
            {creating ? 'building…' : 'build one'}
          </button>.
        </p>
      )}
    </section>
  );
};

export default AskPanel;
