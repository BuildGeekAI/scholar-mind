import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, MessageSquareQuote, Users } from 'lucide-react';
import * as api from '../services/api';

/**
 * The advisors available to you — your own, and any shared with you.
 *
 * "Hiring" is selecting who to put the question to. There is no roster to join
 * and nothing to persist: an advisor is a library someone has given a voice, and
 * consulting one is reading their published work through it.
 */

interface Props {
  onConsult: (advisorIds: string[]) => void;
  onOpenProfile: (profileId: string) => void;
}

const AdvisorGallery: React.FC<Props> = ({ onConsult, onOpenProfile }) => {
  const [advisors, setAdvisors] = useState<api.Advisor[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAdvisors()
      .then(setAdvisors)
      .catch(e => setError(e.message || 'Could not load advisors.'));
  }, []);

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // An advisor with nothing indexed has nothing to answer from, so it cannot be
  // selected — better than letting it abstain on every question.
  const ready = useMemo(() => (advisors ?? []).filter(a => a.indexedCount > 0), [advisors]);
  const empty = useMemo(() => (advisors ?? []).filter(a => a.indexedCount === 0), [advisors]);

  if (error) {
    return <p className="p-6 text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!advisors) {
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="h-5 w-5 animate-spin text-scholarly-600" aria-label="Loading advisors" />
      </div>
    );
  }

  if (!advisors.length) {
    return (
      <div className="p-10 text-center">
        <Users className="mx-auto mb-3 h-8 w-8 text-slate-400" aria-hidden />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          No advisors yet. Open a library and turn it into one to consult its author's work.
        </p>
      </div>
    );
  }

  return (
    <section className="p-6">
      <header className="mb-5">
        <h2 className="font-serif text-xl text-slate-900 dark:text-slate-100">Advisors</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Answers are grounded in each advisor's published work and cite the passages they came
          from. An advisor whose work does not cover a question will say so.
        </p>
        {/* The single most common reason an advisor disappoints. */}
        {ready.some(a => a.deepCount === 0) && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            Some advisors below hold only abstracts. Indexing makes a paper findable;
            <span className="font-medium"> Generate</span> is what puts its substance in reach.
          </p>
        )}
      </header>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ready.map(advisor => {
          const isSelected = selected.has(advisor.id);
          const name = advisor.advisorName || advisor.scholarName || advisor.title;
          return (
            <li key={advisor.id}>
              <button
                type="button"
                onClick={() => toggle(advisor.id)}
                aria-pressed={isSelected}
                className={`w-full rounded-xl border p-4 text-left transition ${
                  isSelected
                    ? 'border-scholarly-500 bg-scholarly-50 dark:border-scholarly-400 dark:bg-scholarly-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl" aria-hidden>{advisor.emoji}</span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900 dark:text-slate-100">{name}</p>
                    {advisor.advisorTitle && (
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {advisor.advisorTitle}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      {advisor.indexedCount} indexed{' '}
                      {advisor.indexedCount === 1 ? 'source' : 'sources'}
                      {!advisor.mine && ' · shared with you'}
                    </p>
                    {/* Said plainly, because otherwise a thin library reads as a
                        stupid advisor and the user has no way to tell which. */}
                    {advisor.deepCount === 0 ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        Abstracts only — answers will be shallow. Run{' '}
                        <span className="font-medium">Generate</span> on its sources.
                      </p>
                    ) : advisor.deepCount < advisor.indexedCount ? (
                      <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                        {advisor.deepCount} of {advisor.indexedCount} with full text
                      </p>
                    ) : null}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {empty.length > 0 && (
        <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
          {empty.length} advisor{empty.length === 1 ? '' : 's'} not shown: nothing indexed yet, so
          there is nothing to answer from.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => onOpenProfile(empty[0].id)}
          >
            Open {empty[0].advisorName || empty[0].title}
          </button>
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          disabled={!selected.size}
          onClick={() => onConsult([...selected])}
          className="inline-flex items-center gap-2 rounded-lg bg-scholarly-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-scholarly-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <MessageSquareQuote className="h-4 w-4" aria-hidden />
          Consult {selected.size || ''} {selected.size === 1 ? 'advisor' : 'advisors'}
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-sm text-slate-500 underline dark:text-slate-400"
          >
            Clear
          </button>
        )}
      </div>
    </section>
  );
};

export default AdvisorGallery;
