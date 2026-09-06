import React, { useState } from 'react';
import { Plus, MoreVertical, Search, X } from 'lucide-react';
import { Profile } from '../types';

interface DashboardProps {
  profiles: Profile[];
  onCreateProfile: () => void;
  onSelectProfile: (id: string) => void;
  onDeleteProfile: (id: string, e: React.MouseEvent) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ profiles, onCreateProfile, onSelectProfile, onDeleteProfile }) => {
  const [searchTerm, setSearchTerm] = useState('');
  
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
      (p.scholar?.name || '').toLowerCase().includes(searchTerm.toLowerCase())
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="min-h-screen bg-[#F9FAFB] p-8 font-sans">
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-12 gap-6">
           <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 font-bold text-lg">
                 ALL
              </div>
              <h1 className="text-xl font-medium text-slate-700">My profiles</h1>
           </div>
           
           <div className="flex flex-1 md:justify-end items-center gap-3">
              {/* Search Bar */}
              <div className="relative group w-full md:w-64 lg:w-80 transition-all focus-within:w-full md:focus-within:w-96 z-10">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-slate-600 transition-colors" />
                  <input 
                    type="text" 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search profiles..."
                    className="w-full pl-10 pr-10 py-2.5 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-slate-200 shadow-sm transition-all"
                  />
                  {searchTerm && (
                    <button 
                      onClick={() => setSearchTerm('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
              </div>
              
              <div className="hidden md:block w-px h-8 bg-slate-200 mx-1"></div>

              <button className="hidden sm:flex px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors items-center gap-2">
                 <div className="grid grid-cols-2 gap-0.5">
                    <div className="w-1 h-1 bg-slate-500 rounded-full"></div>
                    <div className="w-1 h-1 bg-slate-500 rounded-full"></div>
                    <div className="w-1 h-1 bg-slate-500 rounded-full"></div>
                    <div className="w-1 h-1 bg-slate-500 rounded-full"></div>
                 </div>
              </button>
              <button 
                onClick={onCreateProfile}
                className="px-4 py-2.5 bg-black text-white rounded-full text-sm font-medium hover:bg-slate-800 transition-colors flex items-center gap-2 whitespace-nowrap shadow-lg shadow-slate-200"
              >
                 <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Create new</span><span className="sm:hidden">New</span>
              </button>
           </div>
        </div>

        {/* Content Section */}
        <div className="mb-8">
           <h2 className="text-2xl font-medium text-slate-800 mb-6 flex items-center gap-2">
             {searchTerm ? (
               <>Search results <span className="text-slate-400 text-lg font-normal">({filteredProfiles.length})</span></>
             ) : 'Recent profiles'}
           </h2>
           
           {filteredProfiles.length === 0 && searchTerm ? (
             <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                    <Search className="w-8 h-8 opacity-40" />
                </div>
                <p className="font-medium">No profiles found matching "{searchTerm}"</p>
                <button onClick={() => setSearchTerm('')} className="mt-2 text-blue-600 hover:underline text-sm font-medium">Clear search</button>
             </div>
           ) : (
             <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                
                {/* Create New Card - Only show if not searching */}
                {!searchTerm && (
                  <button 
                    onClick={onCreateProfile}
                    className="group relative aspect-[4/3] bg-white rounded-2xl border-2 border-dashed border-slate-200 hover:border-blue-400 hover:bg-blue-50/30 transition-all flex flex-col items-center justify-center text-slate-400 hover:text-blue-500"
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
                     className="group relative aspect-[4/3] bg-white rounded-2xl p-6 shadow-sm border border-slate-100 hover:shadow-xl hover:shadow-slate-200/50 hover:-translate-y-1 transition-all cursor-pointer flex flex-col justify-between"
                   >
                      <div className="flex justify-between items-start">
                         <span className="text-4xl filter drop-shadow-sm transition-transform group-hover:scale-110">{profile.emoji}</span>
                         <button 
                           onClick={(e) => onDeleteProfile(profile.id, e)}
                           className="p-1.5 rounded-full hover:bg-red-50 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                         >
                            <MoreVertical className="w-5 h-5" />
                         </button>
                      </div>

                      <div>
                         <h3 className="text-xl font-medium text-slate-800 mb-2 truncate pr-2 group-hover:text-blue-600 transition-colors">
                            {profile.title}
                         </h3>
                         <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                            <span>{formatDate(profile.updatedAt)}</span>
                            <span className="flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded-full">
                               <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                               {profile.scholar?.papers.length || 0} sources
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