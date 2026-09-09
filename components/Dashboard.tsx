import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Search, X, Download, Sun, Moon, Users } from 'lucide-react';
import { Theme } from './theme';
import * as api from '../services/api';
import AskPanel from './AskPanel';

interface DashboardProps {
  profiles: api.ProfileRecord[];
  theme: Theme;
  onToggleTheme: () => void;
  /** Creates a profile and immediately searches it for the given scholar. */
  onCreateFor: (query: string) => Promise<void>;
  onCreateProfile: () => void;
  onOpenAdvisors: () => void;
  onSelectProfile: (id: string) => void;
  onDeleteProfile: (id: string, e: React.MouseEvent) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ profiles, theme, onToggleTheme, onCreateFor, onCreateProfile, onOpenAdvisors, onSelectProfile, onDeleteProfile }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [subject, setSubject] = useState<string | null>(null);

  /**
   * Subjects come from the topics a scholar search already resolved, so there is
   * nothing to tag by hand. Ordered by how many libraries carry each, because a
   * subject appearing once is a worse filter than one appearing five times.
   */
  const subjects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of profiles) {
      for (const topic of profile.topics ?? []) {
        const key = topic.trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12);
  }, [profiles]);
  
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const filteredProfiles = profiles
    .filter(p =>
      p.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.scholarName || '').toLowerCase().includes(searchTerm.toLowerCase())
    )
    .filter(p => !subject || (p.topics ?? []).some(t => t.trim() === subject))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="min-h-screen bg-surface p-8 font-sans">
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-12 gap-6">
           <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-line flex items-center justify-center text-muted font-bold text-lg">
                 ALL
              </div>
              <h1 className="text-xl font-medium text-ink">My profiles</h1>
              <button
                onClick={onToggleTheme}
                className="ml-2 p-2 rounded-lg hover:bg-panel-2 text-muted hover:text-ink transition-colors"
                title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              >
                {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
           </div>
           
           <div className="flex flex-1 md:justify-end items-center gap-3">
              {/* Search Bar */}
              <div className="relative group w-full md:w-64 lg:w-80 transition-all focus-within:w-full md:focus-within:w-96 z-10">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle group-focus-within:text-muted transition-colors" />
                  <input 
                    type="text" 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search profiles..."
                    className="w-full pl-10 pr-10 py-2.5 bg-panel border border-line rounded-xl text-sm outline-none focus:ring-2 focus:ring-line shadow-sm transition-all"
                  />
                  {searchTerm && (
                    <button 
                      onClick={() => setSearchTerm('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-ink"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
              </div>
              
              <div className="hidden md:block w-px h-8 bg-line mx-1"></div>

              <button className="hidden sm:flex px-4 py-2 bg-panel border border-line rounded-lg text-sm font-medium text-ink hover:bg-surface transition-colors items-center gap-2">
                 <div className="grid grid-cols-2 gap-0.5">
                    <div className="w-1 h-1 bg-muted rounded-full"></div>
                    <div className="w-1 h-1 bg-muted rounded-full"></div>
                    <div className="w-1 h-1 bg-muted rounded-full"></div>
                    <div className="w-1 h-1 bg-muted rounded-full"></div>
                 </div>
              </button>
              <button
                onClick={onOpenAdvisors}
                className="px-4 py-2.5 bg-panel border border-line rounded-lg text-sm font-medium text-ink hover:bg-surface transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                 <Users className="w-4 h-4" /> <span className="hidden sm:inline">Advisors</span>
              </button>
              <button 
                onClick={onCreateProfile}
                className="px-4 py-2.5 bg-ink text-surface rounded-full text-sm font-medium hover:opacity-90 transition-colors flex items-center gap-2 whitespace-nowrap shadow-lg shadow-black/5 dark:shadow-black/40"
              >
                 <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Create new</span><span className="sm:hidden">New</span>
              </button>
           </div>
        </div>

        <AskPanel
          libraries={profiles}
          onOpenProfile={onSelectProfile}
          onCreateFor={onCreateFor}
        />

        {/* Content Section */}
        <div className="mb-8">
           <h2 className="text-2xl font-medium text-ink mb-4 flex items-center gap-2">
             {searchTerm ? (
               <>Search results <span className="text-subtle text-lg font-normal">({filteredProfiles.length})</span></>
             ) : subject ? (
               <>{subject} <span className="text-subtle text-lg font-normal">({filteredProfiles.length})</span></>
             ) : (
               <>Your libraries <span className="text-subtle text-lg font-normal">({profiles.length})</span></>
             )}
           </h2>

           {subjects.length > 0 && (
             <div className="mb-6 flex flex-wrap gap-2">
               <button
                 onClick={() => setSubject(null)}
                 aria-pressed={subject === null}
                 className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                   subject === null ? 'bg-ink text-surface' : 'bg-panel-2 text-muted hover:text-ink'
                 }`}
               >
                 All subjects
               </button>
               {subjects.map(([name, count]) => (
                 <button
                   key={name}
                   onClick={() => setSubject(s => (s === name ? null : name))}
                   aria-pressed={subject === name}
                   className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                     subject === name ? 'bg-ink text-surface' : 'bg-panel-2 text-muted hover:text-ink'
                   }`}
                 >
                   {name} <span className="opacity-60">{count}</span>
                 </button>
               ))}
             </div>
           )}
           
           {filteredProfiles.length === 0 && searchTerm ? (
             <div className="flex flex-col items-center justify-center py-20 text-subtle">
                <div className="w-16 h-16 bg-panel-2 rounded-full flex items-center justify-center mb-4">
                    <Search className="w-8 h-8 opacity-40" />
                </div>
                <p className="font-medium">No profiles found matching "{searchTerm}"</p>
                <button onClick={() => { setSearchTerm(''); setSubject(null); }} className="mt-2 text-blue-600 hover:underline text-sm font-medium">Clear search</button>
             </div>
           ) : (
             <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                
                {/* Create New Card - Only show if not searching */}
                {!searchTerm && (
                  <button 
                    onClick={onCreateProfile}
                    className="group relative aspect-[4/3] bg-panel rounded-2xl border-2 border-dashed border-line hover:border-blue-400 hover:bg-blue-50/30 transition-all flex flex-col items-center justify-center text-subtle hover:text-blue-500"
                  >
                    <div className="w-16 h-16 rounded-full bg-blue-50 group-hover:bg-blue-100 flex items-center justify-center mb-4 transition-colors text-blue-500">
                        <Plus className="w-8 h-8" />
                    </div>
                    <span className="font-medium text-lg">Create new profile</span>
                  </button>
                )}

                {/* Profile Cards */}
                {filteredProfiles.map((profile) => (
                   <div 
                     key={profile.id}
                     onClick={() => onSelectProfile(profile.id)}
                     className="group relative aspect-[4/3] bg-panel rounded-2xl p-6 shadow-sm border border-line hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/40 hover:-translate-y-1 transition-all cursor-pointer flex flex-col justify-between"
                   >
                      <div className="flex justify-between items-start">
                         <span className="text-4xl filter drop-shadow-sm transition-transform group-hover:scale-110">{profile.emoji}</span>
                         {/* Dimmed rather than hidden: opacity-0 made these
                             unreachable on touch, where nothing ever hovers. */}
                         <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 focus-within:opacity-100 transition-all">
                           <a
                             href={api.exportUrl(profile.id)}
                             onClick={(e) => e.stopPropagation()}
                             title="Export this profile as a ZIP"
                             aria-label={`Export ${profile.title} as a ZIP`}
                             className="p-1.5 rounded-full hover:bg-scholarly-50 dark:hover:bg-scholarly-500/15 text-subtle hover:text-scholarly-600 transition-colors"
                           >
                              <Download className="w-5 h-5" />
                           </a>
                           <button 
                             onClick={(e) => onDeleteProfile(profile.id, e)}
                             title="Delete this profile"
                             aria-label={`Delete ${profile.title}`}
                             className="p-1.5 rounded-full hover:bg-red-50 dark:hover:bg-red-500/15 text-subtle hover:text-red-500 dark:hover:text-red-300 transition-all"
                           >
                              <Trash2 className="w-5 h-5" />
                           </button>
                         </div>
                      </div>

                      <div>
                         <h3 className="text-xl font-medium text-ink mb-2 truncate pr-2 group-hover:text-blue-600 transition-colors">
                            {profile.title}
                         </h3>
                         <div className="flex items-center justify-between text-xs font-medium text-muted">
                            <span>{formatDate(profile.updatedAt)}</span>
                            <span className="flex items-center gap-1 bg-panel-2 px-2 py-0.5 rounded-full">
                               <span className="w-1.5 h-1.5 rounded-full bg-subtle"></span>
                               {profile.affiliation || 'No sources yet'}
                            </span>
                         </div>
                      </div>
                   </div>
                ))}

             </div>
           )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;