import React, { useState } from 'react';
import { Check, Loader2, UserRoundCog } from 'lucide-react';
import * as api from '../services/api';

/**
 * Turns a library into an advisor.
 *
 * The brief shapes how the advisor engages — its register and its standpoint.
 * It deliberately does not supply facts: those come from the retrieved passages,
 * and a brief that asserts things invites answers the person never wrote. The
 * form says so, because this is the field where the mistake gets made.
 */

interface Props {
  profile: api.ProfileRecord;
  onSaved: (updated: api.ProfileRecord) => void;
}

const AdvisorSettings: React.FC<Props> = ({ profile, onSaved }) => {
  const [enabled, setEnabled] = useState(!!profile.advisorEnabled);
  const [name, setName] = useState(profile.advisorName ?? profile.scholarName ?? '');
  const [title, setTitle] = useState(profile.advisorTitle ?? '');
  const [brief, setBrief] = useState(profile.advisorBrief ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.updateAdvisor(profile.id, { enabled, name, title, brief });
      onSaved(updated);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(e.message || 'Could not save advisor settings.');
    } finally {
      setSaving(false);
    }
  };

  const field =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-scholarly-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

  return (
    <section className="rounded-xl border border-slate-200 p-5 dark:border-slate-800">
      <header className="mb-4 flex items-center gap-2">
        <UserRoundCog className="h-4 w-4 text-slate-500" aria-hidden />
        <h3 className="font-medium text-slate-900 dark:text-slate-100">Advisor</h3>
      </header>

      <label className="mb-4 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          className="mt-0.5 rounded border-slate-300 dark:border-slate-700"
        />
        <span>
          Make this library consultable as an advisor.
          <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
            Answers are drawn only from what is indexed here, and cite the passages they came from.
            Anyone this library is shared with can consult it.
          </span>
        </span>
      </label>

      {enabled && (
        <div className="space-y-3">
          <div>
            <label htmlFor="advisor-name" className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
              Name
            </label>
            <input
              id="advisor-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Albert Einstein"
              className={field}
            />
          </div>

          <div>
            <label htmlFor="advisor-title" className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
              Title
            </label>
            <input
              id="advisor-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Theoretical physicist, 1879–1955"
              className={field}
            />
          </div>

          <div>
            <label htmlFor="advisor-brief" className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
              How this advisor engages
            </label>
            <textarea
              id="advisor-brief"
              value={brief}
              onChange={e => setBrief(e.target.value)}
              rows={4}
              placeholder="Reasons from first principles and thought experiments; sceptical of statistical explanations where a mechanism could be found."
              className={field}
            />
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Describe manner and standpoint, not facts. Everything factual comes from the indexed
              work — a brief that asserts positions will produce answers this person never wrote.
            </p>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : saved ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : null}
        {saved ? 'Saved' : 'Save'}
      </button>
    </section>
  );
};

export default AdvisorSettings;
