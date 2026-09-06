/**
 * Light or dark, and nothing else. This is display chrome rather than app data,
 * so it lives in localStorage: it belongs to the device, not the profile, and a
 * round trip to the server before the first paint would guarantee a flash.
 */
export type Theme = 'light' | 'dark';

const KEY = 'scholarMind_theme';

const systemPrefersDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const readTheme = (): Theme => {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private browsing, or storage disabled. Fall through to the system choice.
  }
  return systemPrefersDark() ? 'dark' : 'light';
};

export const applyTheme = (theme: Theme): void => {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
};
