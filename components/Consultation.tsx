import React, { useCallback, useState } from 'react';
import { ArrowLeft, Loader2, Quote, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import * as api from '../services/api';

/**
 * Put one question to a panel.
 *
 * Answers stream in per advisor rather than arriving together — each is a
 * retrieval plus a model call, so the first is useful long before the last.
 * Every answer carries the passages it was built from: those are the passages
 * actually handed to the model, not sources the model claimed afterwards.
 */

interface Props {
  advisorIds: string[];
  onBack: () => void;
}

const Consultation: React.FC<Props> = ({ advisorIds, onBack }) => {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [answers, setAnswers] = useState<api.AdvisorAnswer[]>([]);
  const [synthesis, setSynthesis] = useState<string | null>(null);
  const [wantSynthesis, setWantSynthesis] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ask = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!question.trim() || running) return;

      setRunning(true);
      setError(null);
      setAnswers([]);
      setSynthesis(null);
      setAsked(question);

      try {
        await api.consult(question, advisorIds, { synthesise: wantSynthesis }, {
          onAdvisor: answer => setAnswers(prev => [...prev, answer]),
          onSynthesis: setSynthesis,
          onError: setError,
        });
      } catch (e: any) {
        setError(e.message || 'Consultation failed.');
      } finally {
        setRunning(false);
      }
    },
    [question, advisorIds, wantSynthesis, running]
  );

  const toggleSources = (profileId: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });

  const pending = running ? advisorIds.length - answers.length : 0;

  return (
    <section className="mx-auto max-w-3xl p-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Advisors
      </button>

      <form onSubmit={ask} className="mb-6">
        <label htmlFor="consult-question" className="sr-only">
          Your question
        </label>
        <div className="flex gap-2">
          <input
            id="consult-question"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={`Ask ${advisorIds.length} ${advisorIds.length === 1 ? 'advisor' : 'advisors'}…`}
            disabled={running}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-scholarly-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <button
            type="submit"
            disabled={running || !question.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-scholarly-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-scholarly-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            Ask
          </button>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={wantSynthesis}
            onChange={e => setWantSynthesis(e.target.checked)}
            disabled={running}
            className="rounded border-slate-300 dark:border-slate-700"
          />
          Summarise where they agree and differ
        </label>
      </form>

      {error && (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}

      {asked && (
        <p className="mb-5 border-l-2 border-slate-300 pl-3 font-serif text-lg text-slate-800 dark:border-slate-700 dark:text-slate-200">
          {asked}
        </p>
      )}

      <div className="space-y-5">
        {answers.map(answer => (
          <article
            key={answer.profileId}
            className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"
          >
            <header className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="font-medium text-slate-900 dark:text-slate-100">
                {answer.advisorName}
              </h3>
              {/* Stated, not implied: this is published work read aloud, not the person. */}
              <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                from published work
              </span>
            </header>

            <div className="prose prose-sm prose-slate max-w-none dark:prose-invert">
              <ReactMarkdown>{answer.answer}</ReactMarkdown>
            </div>

            {answer.citations.length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => toggleSources(answer.profileId)}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  <Quote className="h-3.5 w-3.5" aria-hidden />
                  {expanded.has(answer.profileId) ? 'Hide' : 'Show'} {answer.citations.length}{' '}
                  {answer.citations.length === 1 ? 'passage' : 'passages'}
                </button>

                {expanded.has(answer.profileId) && (
                  <ul className="mt-3 space-y-2">
                    {answer.citations.map((citation, i) => (
                      <li key={`${citation.paperId}-${i}`} className="text-xs text-slate-600 dark:text-slate-400">
                        <span className="font-medium text-slate-700 dark:text-slate-300">
                          {citation.paperTitle}
                        </span>
                        <span className="mt-0.5 block italic">“{citation.snippet}”</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </article>
        ))}

        {pending > 0 && (
          <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Waiting on {pending} more…
          </p>
        )}

        {synthesis && (
          <article className="rounded-xl bg-slate-50 p-5 dark:bg-slate-900">
            <h3 className="mb-3 font-medium text-slate-900 dark:text-slate-100">
              Where they agree and differ
            </h3>
            <div className="prose prose-sm prose-slate max-w-none dark:prose-invert">
              <ReactMarkdown>{synthesis}</ReactMarkdown>
            </div>
          </article>
        )}
      </div>
    </section>
  );
};

export default Consultation;
