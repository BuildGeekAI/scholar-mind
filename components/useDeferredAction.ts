import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Do a destructive thing immediately in the interface, and actually commit it a
 * few seconds later.
 *
 * Replaces a confirmation dialog. A dialog interrupts every delete to guard
 * against the rare wrong one, and people learn to dismiss it without reading —
 * so it costs attention constantly and protects rarely. Deferring inverts that:
 * nothing interrupts, and the rare wrong one is recoverable.
 *
 * The commit is genuinely deferred, so undo needs no server support: nothing has
 * been sent yet. If the page goes away while one is pending it is committed
 * immediately with `keepalive`, because a delete the user asked for and walked
 * away from should still happen.
 */

export interface Pending {
  id: string;
  label: string;
  undo: () => void;
}

const WINDOW_MS = 6000;

export const useDeferredAction = () => {
  const [pending, setPending] = useState<Pending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef<(() => void) | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    commitRef.current = null;
    setPending(null);
  }, []);

  /**
   * `optimistic` runs now, `commit` runs when the window closes, `revert` runs
   * if the user takes it back.
   */
  const defer = useCallback(
    (id: string, label: string, optimistic: () => void, commit: () => void, revert: () => void) => {
      // A second delete while one is pending commits the first rather than
      // losing it — the window is per-action, not global.
      if (commitRef.current) commitRef.current();
      if (timer.current) clearTimeout(timer.current);

      optimistic();
      commitRef.current = commit;

      timer.current = setTimeout(() => {
        commit();
        commitRef.current = null;
        setPending(null);
      }, WINDOW_MS);

      setPending({
        id,
        label,
        undo: () => {
          if (timer.current) clearTimeout(timer.current);
          commitRef.current = null;
          revert();
          setPending(null);
        },
      });
    },
    []
  );

  // Leaving with one pending commits it. `pagehide` fires where `beforeunload`
  // does not on mobile Safari, and the request itself uses keepalive.
  useEffect(() => {
    const flush = () => commitRef.current?.();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  return { pending, defer, clear };
};
