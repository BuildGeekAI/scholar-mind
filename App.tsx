import React, { useState, useEffect } from 'react';
import { Profile } from './types';
import Dashboard from './components/Dashboard';
import ProfileWorkspace from './components/ProfileWorkspace';

const STORAGE_KEY = 'scholarMind_profiles_v1';

const EMOJIS = ['🤖', '🐳', '🤝', '🦀', '🏠', '⚖️', '🛡️', '☁️', '📒', '🦙'];

const App: React.FC = () => {
  // State
  const [profiles, setProfiles] = useState<Profile[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
      return [];
    } catch (e) {
      return [];
    }
  });

  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);

  // Persistence
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  }, [profiles]);

  const handleCreateProfile = () => {
    const newProfile: Profile = {
      id: crypto.randomUUID(),
      title: "Untitled profile",
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      scholar: null,
      chatMessages: [],
      theme: 'Ocean'
    };
    
    setProfiles(prev => [newProfile, ...prev]);
    setActiveProfileId(newProfile.id);
  };

  const handleDeleteProfile = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    // Confirm is handled in sub-component if e is missing, or here if e is present
    // But workspace calls it without event after its own confirm.
    // So we just perform the delete here.
    
    setProfiles(prev => prev.filter(n => n.id !== id));
    if (activeProfileId === id) setActiveProfileId(null);
  };

  const handleUpdateProfile = (updated: Profile) => {
    setProfiles(prev => prev.map(n => n.id === updated.id ? updated : n));
  };

  const activeProfile = profiles.find(n => n.id === activeProfileId);

  // Render
  if (activeProfileId && activeProfile) {
    return (
      <ProfileWorkspace 
        profile={activeProfile}
        onSave={handleUpdateProfile}
        onBack={() => setActiveProfileId(null)}
        onDelete={() => handleDeleteProfile(activeProfile.id)}
      />
    );
  }

  return (
    <Dashboard 
      profiles={profiles}
      onCreateProfile={handleCreateProfile}
      onSelectProfile={setActiveProfileId}
      onDeleteProfile={(id, e) => {
          if (window.confirm("Are you sure you want to delete this profile?")) {
              handleDeleteProfile(id, e);
          }
      }}
    />
  );
};

export default App;