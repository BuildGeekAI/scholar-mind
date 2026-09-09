import React, { useEffect, useMemo, useState } from 'react';
import { Theme } from './theme';
import * as api from '../services/api';
import Sidebar from './Sidebar';
import ChatPane, { Focus } from './ChatPane';

/**
 * The app shell: libraries on the left, the conversation filling the rest.
 *
 * Previously this was an answer box above a grid of cards, which asked the user
 * to scroll away from their question to see what they could ask about. The two
 * halves now sit side by side, and the sidebar's meaning follows the active tab
 * — narrowing which library the chat reads, or choosing who is on the panel.
 */

interface DashboardProps {
  profiles: api.ProfileRecord[];
  theme: Theme;
  me: api.Me | null;
  onToggleTheme: () => void;
  onCreateProfile: () => void;
  onSelectProfile: (id: string) => void;
  onDeleteProfile: (id: string, e: React.MouseEvent) => void;
}

const Dashboard: React.FC<DashboardProps> = ({
  profiles,
  theme,
  me,
  onToggleTheme,
  onCreateProfile,
  onSelectProfile,
  onDeleteProfile,
}) => {
  const [focus, setFocus] = useState<Focus>('libraries');
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [advisorIds, setAdvisorIds] = useState<string[]>([]);
  const [advisors, setAdvisors] = useState<api.Advisor[]>([]);

  useEffect(() => {
    api.listAdvisors().then(setAdvisors).catch(() => setAdvisors([]));
  }, [profiles.length]);

  const libraryName = useMemo(
    () => profiles.find(p => p.id === libraryId)?.title,
    [profiles, libraryId]
  );

  const advisorNames = useMemo(
    () =>
      advisorIds
        .map(id => advisors.find(a => a.id === id))
        .filter(Boolean)
        .map(a => a!.advisorName || a!.scholarName || a!.title),
    [advisorIds, advisors]
  );

  const toggleAdvisor = (id: string) =>
    setAdvisorIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Sidebar
        profiles={profiles}
        advisors={advisors}
        focus={focus}
        libraryId={libraryId}
        advisorIds={advisorIds}
        me={me}
        theme={theme}
        onSelectLibrary={setLibraryId}
        onToggleAdvisor={toggleAdvisor}
        onOpenProfile={onSelectProfile}
        onCreateProfile={onCreateProfile}
        onDeleteProfile={onDeleteProfile}
        onToggleTheme={onToggleTheme}
      />

      <main className="min-w-0 flex-1">
        <ChatPane
          focus={focus}
          onFocusChange={setFocus}
          libraryId={libraryId}
          libraryName={libraryName}
          advisorIds={advisorIds}
          advisorNames={advisorNames}
        />
      </main>
    </div>
  );
};

export default Dashboard;
