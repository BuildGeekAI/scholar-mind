import React from 'react';
import { Undo2 } from 'lucide-react';
import type { Pending } from './useDeferredAction';

/**
 * What replaced the confirmation dialog: an unobtrusive way back, rather than a
 * question asked before every delete regardless of whether it was a mistake.
 */
const UndoToast: React.FC<{ pending: Pending | null }> = ({ pending }) =>
  pending ? (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-xl bg-slate-900/95 px-5 py-3 text-sm text-white shadow-2xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900"
    >
      <span>Deleted {pending.label}</span>
      <button
        onClick={pending.undo}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium underline underline-offset-2 transition hover:opacity-80"
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
        Undo
      </button>
    </div>
  ) : null;

export default UndoToast;
