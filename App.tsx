import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Theme, applyTheme, readTheme } from './components/theme';
import * as api from './services/api';
import Dashboard from './components/Dashboard';
import ProfileWorkspace from './components/ProfileWorkspace';
import SignIn from './components/SignIn';

const EMOJIS = ['🤖', '🐳', '🤝', '🦀', '🏠', '⚖️', '🛡️', '☁️', '📒', '🦙'];

const App: React.FC = () => {
  const [profiles, setProfiles] = useState<api.ProfileRecord[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);

  // null while unknown, false once the server has said it does not know us.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);


  useEffect(() => { applyTheme(theme); }, [theme]);
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  const refresh = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
      setError(null);
    } catch (e: any) {
      // 401 is not an error to report; it means "sign in first".
      if (e?.status === 401) {
        setSignedIn(false);
        return;
      }
      setError(e.message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Establish who we are before asking for anything. A 401 here is the ordinary
   * first-visit path, not a failure.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.me();
        if (!cancelled) setSignedIn(true);
      } catch (e: any) {
        if (cancelled) return;
        setSignedIn(false);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (signedIn) refresh(); }, [signedIn, refresh]);

  /**
   * The landing page found nothing for a query, so build it: a fresh profile,
   * then the scholar search inside it. Opening the workspace only after the
   * search lands means the user never sees an empty shell.
   */
  const handleCreateFor = useCallback(async (query: string) => {
    try {
      const created = await api.createProfile(
        'Untitled profile',
        EMOJIS[Math.floor(Math.random() * EMOJIS.length)]
      );
      try {
        await api.searchScholar(created.id, query);
      } catch (searchError: any) {
        // A duplicate here means another profile already covers it; the
        // workspace surfaces that. Anything else is reported but still opens,
        // because the profile exists and the user can retry inside it.
        console.error(searchError);
      }
      await refresh();
      setActiveProfileId(created.id);
    } catch (e: any) {
      alert(e.message || 'Could not create that library.');
    }
  }, [refresh]);

  /**
   * One-time hand-off from the localStorage era. The key is cleared only after
   * the server confirms the import, so a failure leaves the old data intact.
   */
  const legacyPayload = (() => {
    try {
      const raw = localStorage.getItem(api.LEGACY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch {
      return null;
    }
  })();

  const handleImportLegacy = async () => {
    if (!legacyPayload) return;
    setImporting(true);
    try {
      await api.importLegacy(legacyPayload);
      localStorage.removeItem(api.LEGACY_KEY);
      await refresh();
    } catch (e: any) {
      alert(e.message || 'Import failed. Your local data has been left untouched.');
    } finally {
      setImporting(false);
    }
  };

  const handleCreateProfile = async () => {
    try {
      const created = await api.createProfile(
        'Untitled profile',
        EMOJIS[Math.floor(Math.random() * EMOJIS.length)]
      );
      setProfiles(prev => [created, ...prev]);
      setActiveProfileId(created.id);
    } catch (e: any) {
      alert(e.message || 'Could not create profile.');
    }
  };

  /**
   * Optimistic: deleting a profile also tears down its File Search store, its
   * rows and its blobs, which takes long enough to feel
   * broken if the UI waits. The row disappears immediately and is restored if
   * the server rejects it.
   */
  const handleDeleteProfile = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const snapshot = profiles;
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (activeProfileId === id) setActiveProfileId(null);
    try {
      await api.deleteProfile(id);
    } catch (err: any) {
      setProfiles(snapshot);
      alert(err.message || 'Could not delete profile.');
    }
  };

  // Identity is settled before anything else renders: every other view assumes
  // the server will answer, and it will not until we are signed in.
  if (signedIn === null) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-surface">
        <Loader2 className="w-6 h-6 text-scholarly-600 animate-spin" />
      </div>
    );
  }

  if (signedIn === false) return <SignIn />;

  if (activeProfileId) {
    return (
      <ProfileWorkspace
        profileId={activeProfileId}
        onBack={() => { setActiveProfileId(null); refresh(); }}
        onOpenProfile={(id: string) => { setActiveProfileId(id); refresh(); }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onDelete={() => handleDeleteProfile(activeProfileId)}
      />
    );
  }

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-surface">
        <Loader2 className="w-6 h-6 text-scholarly-600 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-surface text-center px-6">
        <p className="text-ink font-semibold">Could not reach the server.</p>
        <p className="text-muted text-sm max-w-md">{error}</p>
        <button onClick={refresh} className="px-4 py-2 rounded-lg bg-scholarly-600 text-white text-sm font-medium">
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {legacyPayload && (
        <div className="bg-scholarly-600 text-white px-6 py-3 flex items-center justify-between gap-4 text-sm">
          <span>
            Found {legacyPayload.length} profile{legacyPayload.length === 1 ? '' : 's'} saved in this
            browser. Import them to your account?
          </span>
          <button
            onClick={handleImportLegacy}
            disabled={importing}
            className="px-3 py-1.5 rounded-lg bg-panel/20 hover:bg-panel/30 font-medium disabled:opacity-60 shrink-0"
          >
            {importing ? 'Importing…' : 'Import now'}
          </button>
        </div>
      )}
      <Dashboard
        profiles={profiles}
        onCreateProfile={handleCreateProfile}
        onCreateFor={handleCreateFor}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSelectProfile={setActiveProfileId}
        onDeleteProfile={(id, e) => {
          // Stopped before the prompt, not inside the handler: otherwise
          // cancelling the delete still let the click reach the card and
          // opened the profile the user just decided to keep.
          e.stopPropagation();
          const profile = profiles.find(p => p.id === id);
          const name = profile?.title || 'this profile';
          if (window.confirm(`Delete “${name}”? Its sources, chat and search index go with it. This cannot be undone.`)) {
            handleDeleteProfile(id, e);
          }
        }}
      />
    </>
  );
};

export default App;
