import React, { useCallback, useRef, useState } from 'react';
import { ArrowRight, Loader2, MessageSquare, Search, Sparkles, Library } from 'lucide-react';
import * as api from '../services/api';
import { Citation } from '../types';

interface LandingSearchProps {
  onOpenProfile: (id: string) => void;
  /** Builds a library for a scholar nobody has covered yet. */
  onCreateFor: (query: string) => Promise<void>;
}

type Mode = 'find' | 'ask';

/**
 * The way into the app. One box, two things to do with it: find a library that
 * already exists, or ask a question across all of them.
 *
 * Finding is answered from stored identities alone — no model call — so
 * arriving with a scholar in mind lands in their library immediately instead of
 * paying for a search that rediscovers what is already indexed.
 */
const LandingSearch: React.FC<LandingSearchProps> = ({ onOpenProfile, onCreateFor }) => {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('find');
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<api.DiscoveredProfile[] | null>(null);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [scope, setScope] = useState<{ searched: string[]; skipped: number; grounded: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const answerRef = useRef('');

  const runFind = useCallback(async (q: string) => {
    setMatches(null);
    const { matches: found } = await api.discover(q);
    setMatches(found);
  }, []);

  const runAsk = useCallback(async (q: string) => {
    answerRef.current = '';
    setAnswer('');
    setCitations([]);
    setScope(null);
    await api.streamChat(
      null,
      q,
      false,
      chunk => {
        answerRef.current += chunk;
        setAnswer(answerRef.current);
      },
      info =>
        setScope({
          searched: info.searchedLibraries ?? [],
          skipped: info.skippedLibraries ?? 0,
          grounded: info.grounded,
        }),
      message => setAnswer(prev => prev || message),
      received => setCitations(received)
    );
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      if (mode === 'find') await runFind(q);
      else await runAsk(q);
    } catch (error: any) {
      if (mode === 'ask') setAnswer(error.message || 'Could not answer that.');
      else setMatches([]);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      await onCreateFor(query.trim());
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mb-12">
      <div className="text-center mb-6">
        <h1 className="text-3xl md:text-4xl font-serif font-bold text-ink tracking-tight">
          What do you want to understand?
        </h1>
        <p className="text-muted mt-2 text-sm md:text-base">
          Find a library you already have, or ask a question across all of them.
        </p>
      </div>

      <div className="flex justify-center mb-4">
        <div className="flex bg-panel-2 p-1 rounded-xl border border-line">
          <button
            onClick={() => setMode('find')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${mode === 'find' ? 'bg-panel text-scholarly-700 shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            <Search className="w-4 h-4" /> Find a library
          </button>
          <button
            onClick={() => setMode('ask')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${mode === 'ask' ? 'bg-panel text-scholarly-700 shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            <MessageSquare className="w-4 h-4" /> Ask everything
          </button>
        </div>
      </div>

      <form onSubmit={submit} className="relative max-w-3xl mx-auto">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={
            mode === 'find'
              ? 'A scholar, a topic, or a Google Scholar link...'
              : 'Ask anything about what you have collected...'
          }
          className="w-full pl-6 pr-16 py-4 rounded-2xl border-0 ring-1 ring-line bg-panel shadow-lg shadow-black/5 dark:shadow-black/40 focus:ring-2 focus:ring-scholarly-400 outline-none transition-all text-lg text-ink placeholder:text-subtle"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="absolute right-2 top-2 bottom-2 bg-scholarly-600 text-white rounded-xl px-5 hover:bg-scholarly-700 transition-all disabled:bg-line disabled:text-subtle shadow-md flex items-center justify-center"
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
        </button>
      </form>

      {/* Find results */}
      {mode === 'find' && matches && (
        <div className="max-w-3xl mx-auto mt-6 animate-in fade-in slide-in-from-top-2 duration-300">
          {matches.length > 0 ? (
            <div className="space-y-2">
              {matches.map(match => (
                <button
                  key={match.id}
                  onClick={() => onOpenProfile(match.id)}
                  className="w-full text-left bg-panel border border-line rounded-2xl p-4 hover:border-scholarly-300 hover:shadow-md transition-all flex items-center gap-4 group"
                >
                  <span className="text-2xl shrink-0">{match.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink truncate">{match.title}</span>
                      {match.exact && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30">
                          exact match
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted mt-0.5 truncate">
                      {match.affiliation || 'Collection'} · {match.sourceCount} source
                      {match.sourceCount === 1 ? '' : 's'} · {match.indexedCount} indexed
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-subtle group-hover:text-scholarly-600 shrink-0" />
                </button>
              ))}
            </div>
          ) : (
            <div className="bg-panel border border-dashed border-line rounded-2xl p-8 text-center">
              <Library className="w-8 h-8 text-subtle mx-auto mb-3" />
              <p className="text-ink font-medium">Nothing here covers “{query}” yet.</p>
              <button
                onClick={create}
                disabled={creating}
                className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-scholarly-600 text-white font-semibold hover:bg-scholarly-700 transition-all disabled:opacity-60"
              >
                {creating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Building the library...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" /> Build a library for it
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Ask results */}
      {mode === 'ask' && (answer || busy) && (
        <div className="max-w-3xl mx-auto mt-6 bg-panel border border-line rounded-2xl p-6 shadow-sm animate-in fade-in duration-300">
          {scope && (
            <div className="text-xs text-muted mb-3 pb-3 border-b border-line">
              {scope.grounded ? (
                <>
                  Answered from {scope.searched.length} librar
                  {scope.searched.length === 1 ? 'y' : 'ies'}: {scope.searched.join(', ')}
                  {scope.skipped > 0 && (
                    // The API takes at most five stores per call, so a bigger
                    // collection is genuinely not all being searched.
                    <span className="text-amber-700 dark:text-amber-300">
                      {' '}
                      — {scope.skipped} more not searched (five at a time)
                    </span>
                  )}
                </>
              ) : (
                <>Answered from the web — nothing indexed yet.</>
              )}
            </div>
          )}
          <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-ink">
            {answer || <Loader2 className="w-4 h-4 animate-spin text-muted" />}
          </div>
          {citations.length > 0 && (
            <div className="mt-4 pt-3 border-t border-line">
              <div className="text-xs font-bold uppercase tracking-wider text-subtle mb-2">Sources</div>
              <ul className="space-y-1">
                {citations.map((citation, i) => (
                  <li key={i} className="text-xs text-muted truncate">
                    · {citation.fileName}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LandingSearch;
