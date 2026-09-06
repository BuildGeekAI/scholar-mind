import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as api from './services/api';
import Dashboard from './components/Dashboard';
import ProfileWorkspace from './components/ProfileWorkspace';

const EMOJIS = ['🤖', '🐳', '🤝', '🦀', '🏠', '⚖️', '🛡️', '☁️', '📒', '🦙'];

const App: React.FC = () => {
  const [profiles, setProfiles] = useState<api.ProfileRecord[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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
        EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
        'Ocean'
      );
      setProfiles(prev => [created, ...prev]);
      setActiveProfileId(created.id);
    } catch (e: any) {
      alert(e.message || 'Could not create profile.');
    }
  };

  /**
   * Optimistic: deleting a profile also tears down its File Search store, its
   * Firestore subcollections and its blobs, which takes long enough to feel
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

  if (activeProfileId) {
    return (
      <ProfileWorkspace
        profileId={activeProfileId}
        onBack={() => { setActiveProfileId(null); refresh(); }}
        onOpenProfile={(id: string) => { setActiveProfileId(id); refresh(); }}
        onDelete={() => handleDeleteProfile(activeProfileId)}
      />
    );
  }

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 text-scholarly-600 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-slate-50 text-center px-6">
        <p className="text-slate-800 font-semibold">Could not reach the server.</p>
        <p className="text-slate-500 text-sm max-w-md">{error}</p>
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
            className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 font-medium disabled:opacity-60 shrink-0"
          >
            {importing ? 'Importing…' : 'Import now'}
          </button>
        </div>
      )}
      <Dashboard
        profiles={profiles}
        onCreateProfile={handleCreateProfile}
        onSelectProfile={setActiveProfileId}
        onDeleteProfile={(id, e) => {
          if (window.confirm('Are you sure you want to delete this profile?')) {
            handleDeleteProfile(id, e);
          }
        }}
      />
    </>
  );
};

export default App;
