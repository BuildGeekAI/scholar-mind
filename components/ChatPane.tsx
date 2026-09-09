import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Library, Loader2, Quote, Send, UserRoundCog } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Citation } from '../types';
import * as api from '../services/api';

/**
 * The conversation, filling the page.
 *
 * This used to be a single answer box above a grid of cards: the answer replaced
 * the previous one, there was no thread, and the page read as neither a chat nor
 * a dashboard. A conversation needs room and needs to persist across turns —
 * following up is the normal case, not an edge one.
 *
 * What the question is aimed at is a tab, because it changes what the answer can
 * possibly be and should never be inferred.
 */

export type Focus = 'libraries' | 'advisors' | 'web';

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Which advisor or libraries produced it. */
  from?: string;
  citations?: Citation[];
  pending?: boolean;
}

interface Props {
  focus: Focus;
  onFocusChange: (focus: Focus) => void;
  /** Narrows 'libraries' to one; null means everything reachable. */
  libraryId: string | null;
  libraryName?: string;
  /** Advisors selected in the sidebar, for the 'advisors' focus. */
  advisorIds: string[];
  advisorNames: string[];
}

const TABS: Array<{ id: Focus; label: string; icon: typeof Library }> = [
  { id: 'libraries', label: 'My libraries', icon: Library },
  { id: 'advisors', label: 'Advisors', icon: UserRoundCog },
  { id: 'web', label: 'The web', icon: Globe },
];

const ChatPane: React.FC<Props> = ({
  focus,
  onFocusChange,
  libraryId,
  libraryName,
  advisorIds,
  advisorNames,
}) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const streamed = useRef('');

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const placeholder =
    focus === 'web'
      ? 'Ask the web…'
      : focus === 'advisors'
        ? advisorIds.length
          ? `Ask ${advisorNames.slice(0, 2).join(' and ')}${advisorNames.length > 2 ? ` and ${advisorNames.length - 2} more` : ''}…`
          : 'Pick an advisor on the left, then ask…'
        : libraryName
          ? `Ask ${libraryName}…`
          : 'Ask across all your libraries…';

  const send = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = question.trim();
      if (!q || busy) return;
      if (focus === 'advisors' && !advisorIds.length) {
        setError('Pick at least one advisor on the left.');
        return;
      }

      setError(null);
      setQuestion('');
      setBusy(true);
      streamed.current = '';

      const stamp = Date.now();
      setTurns(prev => [...prev, { id: `q-${stamp}`, role: 'user', text: q }]);

      try {
        if (focus === 'advisors') {
          // One reply per advisor, appearing as each lands.
          await api.consult(q, advisorIds, {}, {
            onAdvisor: a =>
              setTurns(prev => [
                ...prev,
                {
                  id: `a-${stamp}-${a.profileId}`,
                  role: 'assistant',
                  from: a.advisorName,
                  text: a.answer,
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
          const id = `a-${stamp}`;
          setTurns(prev => [
            ...prev,
            { id, role: 'assistant', text: '', pending: true, from: focus === 'web' ? 'The web' : undefined },
          ]);

          const patch = (fields: Partial<Turn>) =>
            setTurns(prev => prev.map(t => (t.id === id ? { ...t, ...fields } : t)));

          await api.streamChat(
            focus === 'libraries' ? libraryId : null,
            q,
            focus === 'web',
            text => {
              streamed.current += text;
              patch({ text: streamed.current, pending: false });
            },
            info =>
              patch({
                // Which libraries contributed, not which were asked.
                from: info.searchedLibraries?.length
                  ? info.searchedLibraries.join(', ')
                  : focus === 'web'
                    ? 'The web'
                    : undefined,
                pending: false,
              }),
            message => { setError(message); patch({ pending: false }); },
            cites => patch({ citations: cites })
          );
        }
      } catch (e: any) {
        setError(e.message || 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
    [question, busy, focus, libraryId, advisorIds, advisorNames]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Focus: a tab, because it changes what an answer can possibly be. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-6 py-3">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onFocusChange(id)}
            aria-pressed={focus === id}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
              focus === id ? 'bg-panel-2 text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}

        <span className="ml-auto text-xs text-subtle">
          {focus === 'libraries' && (libraryName ? `Focused on ${libraryName}` : 'All libraries')}
          {focus === 'advisors' &&
            (advisorIds.length
              ? `${advisorIds.length} selected`
              : 'Select on the left')}
          {focus === 'web' && 'No library'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {turns.length === 0 ? (
          <div className="mx-auto mt-16 max-w-lg text-center">
            <p className="font-serif text-xl text-ink">
              {focus === 'advisors'
                ? 'Consult a scholar’s published work'
                : focus === 'web'
                  ? 'Ask anything'
                  : 'Ask your libraries'}
            </p>
            <p className="mt-2 text-sm text-muted">
              {focus === 'advisors'
                ? 'Pick one advisor, or several to see where they differ. Each answers only from what they published.'
                : focus === 'web'
                  ? 'Live search, grounded in nothing you have collected.'
                  : 'Answers cite the passage they came from. Pick one library on the left to narrow it.'}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {turns.map(turn =>
              turn.role === 'user' ? (
                <div key={turn.id} className="flex justify-end">
                  <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-scholarly-600 px-4 py-2.5 text-sm text-white">
                    {turn.text}
                  </p>
                </div>
              ) : (
                <article key={turn.id}>
                  {turn.from && (
                    <p className="mb-1.5 text-xs font-medium text-muted">{turn.from}</p>
                  )}
                  {turn.pending && !turn.text ? (
                    <p className="flex items-center gap-2 text-sm text-muted">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Thinking…
                    </p>
                  ) : (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <ReactMarkdown>{turn.text}</ReactMarkdown>
                    </div>
                  )}

                  {!!turn.citations?.length && (
                    <ul className="mt-3 space-y-1.5 border-l-2 border-line pl-3">
                      {turn.citations.map((c, i) => (
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
              )
            )}
            <div ref={bottom} />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-6 py-4">
        {error && (
          <p role="alert" className="mx-auto mb-3 max-w-3xl text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <form onSubmit={send} className="mx-auto flex max-w-3xl gap-2">
          <label htmlFor="chat-input" className="sr-only">Your question</label>
          <input
            id="chat-input"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={placeholder}
            disabled={busy}
            className="flex-1 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink outline-none transition focus:border-scholarly-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-scholarly-500 to-scholarly-700 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-scholarly-500/25 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            <span className="hidden sm:inline">Ask</span>
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatPane;
