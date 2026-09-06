import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { GraduationCap, ArrowRight, Activity, Palette, Sparkles, Plus, Search, Eraser, Trash2, Save, FilePlus, MessageSquare, ArrowLeft, Edit3, Loader2 } from 'lucide-react';
import { Paper, Message, ScholarData, AppState } from '../types';
import * as api from '../services/api';
import PaperList from './PaperList';
import BlogReader from './BlogReader';
import ChatInterface from './ChatInterface';

// Theme Configuration
const THEMES = {
  Ocean: {
    50: '240 249 255', 100: '224 242 254', 200: '186 230 253', 300: '125 211 252',
    400: '56 189 248', 500: '14 165 233', 600: '2 132 199', 700: '3 105 161',
    800: '7 89 133', 900: '12 74 110'
  },
  Violet: {
    50: '245 243 255', 100: '237 233 254', 200: '221 214 254', 300: '196 181 253',
    400: '167 139 250', 500: '139 92 246', 600: '124 58 237', 700: '109 40 217',
    800: '91 33 182', 900: '76 29 149'
  },
  Emerald: {
    50: '236 253 245', 100: '209 250 229', 200: '167 243 208', 300: '110 231 183',
    400: '52 211 153', 500: '16 185 129', 600: '5 150 105', 700: '4 120 87',
    800: '6 95 70', 900: '6 78 59'
  },
  Rose: {
    50: '255 241 242', 100: '255 228 230', 200: '254 205 211', 300: '253 164 175',
    400: '251 113 133', 500: '244 63 94', 600: '225 29 72', 700: '190 18 60',
    800: '159 18 57', 900: '136 19 55'
  },
  Amber: {
    50: '255 251 235', 100: '254 243 199', 200: '253 230 138', 300: '252 211 77',
    400: '251 191 36', 500: '245 158 11', 600: '217 119 6', 700: '180 83 9',
    800: '146 64 14', 900: '120 53 15'
  }
};

type ThemeName = keyof typeof THEMES;

interface ProfileWorkspaceProps {
  profileId: string;
  onBack: () => void;
  onDelete: () => void;
}

const ProfileWorkspace: React.FC<ProfileWorkspaceProps> = ({ profileId, onBack, onDelete }) => {
  // Server-owned state
  const [profile, setProfile] = useState<api.ProfileRecord | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currentTheme, setCurrentTheme] = useState<ThemeName>('Ocean');
  const [title, setTitle] = useState('');

  const [scholarName, setScholarName] = useState('');
  const [manualPaperTitle, setManualPaperTitle] = useState('');
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [activePaper, setActivePaper] = useState<Paper | null>(null);
  const [isChatProcessing, setIsChatProcessing] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);

  // UI States
  const [inputMode, setInputMode] = useState<'search' | 'add'>('search');
  const [isChatOpen, setIsChatOpen] = useState(true);

  // Selection State
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<string>>(new Set());

  // Load everything for this profile from the server.
  useEffect(() => {
    let cancelled = false;
    api.getProfile(profileId)
      .then(({ profile: p, papers: ps, messages }) => {
        if (cancelled) return;
        setProfile(p);
        setPapers(ps);
        setChatMessages(messages);
        setTitle(p.title);
        setCurrentTheme((p.theme as ThemeName) || 'Ocean');
        setAppState(ps.length ? AppState.READY : AppState.IDLE);
      })
      .catch(e => !cancelled && setLoadError(e.message));
    return () => { cancelled = true; };
  }, [profileId]);

  // The JSX reads a scholar-shaped object; derive it rather than storing it twice.
  const scholar: ScholarData | null = useMemo(() => {
    if (!profile) return null;
    if (!papers.length && !profile.scholarName) return null;
    return {
      name: profile.scholarName || 'My Library',
      affiliation: profile.affiliation || 'Custom Collection',
      topics: profile.topics || ['Mixed'],
      papers,
    };
  }, [profile, papers]);

  // Persist title and theme edits, debounced so typing does not spam the API.
  const savedRef = useRef({ title: '', theme: '' });
  useEffect(() => {
    if (!profile) return;
    if (savedRef.current.title === title && savedRef.current.theme === currentTheme) return;
    const handle = setTimeout(() => {
      savedRef.current = { title, theme: currentTheme };
      api.updateProfile(profile.id, { title, theme: currentTheme }).catch(console.error);
    }, 600);
    return () => clearTimeout(handle);
  }, [title, currentTheme, profile]);

  useEffect(() => {
    if (profile && (title === 'Untitled profile' || !title) && profile.scholarName) {
      setTitle(profile.scholarName);
    }
  }, [profile?.scholarName]);

  // Apply Theme
  useEffect(() => {
    const root = document.documentElement;
    const colors = THEMES[currentTheme];
    if (colors) {
        Object.entries(colors).forEach(([shade, value]) => {
        root.style.setProperty(`--primary-${shade}`, value);
        });
    }
  }, [currentTheme]);

  const isAnyProcessing = useMemo(
    () => papers.some(p => p.status === 'downloading' || p.status === 'processing'),
    [papers]
  );

  const mergePaper = useCallback((incoming: Paper) => {
    setPapers(prev => {
      const index = prev.findIndex(p => p.id === incoming.id);
      if (index === -1) return [incoming, ...prev];
      const next = [...prev];
      next[index] = incoming;
      return next;
    });
  }, []);

  const handleClearSession = async () => {
    if (!profile) return;
    if (!window.confirm("Are you sure you want to clear all papers and chat history from this profile?")) return;
    await Promise.all([
      api.clearMessages(profile.id),
      ...papers.map(paper => api.deletePaper(profile.id, paper.id)),
    ]);
    setPapers([]);
    setChatMessages([]);
    setAppState(AppState.IDLE);
    setSelectedPaperIds(new Set());
    setScholarName('');
  };

  const handleDeleteProfile = () => {
     if (window.confirm("Are you sure you want to delete this profile completely? This action cannot be undone.")) {
         onDelete();
     }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scholarName.trim() || !profile) return;

    setAppState(AppState.SEARCHING);
    setSelectedPaperIds(new Set());

    try {
      const { profile: updated, papers: found } = await api.searchScholar(profile.id, scholarName);
      setProfile(updated);
      setPapers(found);
      setSelectedPaperIds(new Set(found.map(p => p.id)));
      setAppState(AppState.READY);
    } catch (error: any) {
      console.error(error);
      setAppState(AppState.IDLE);
      alert(error.message || 'Failed to find scholar info. Please try again.');
    }
  };

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualPaperTitle.trim() || !profile) return;

    setAppState(AppState.SEARCHING);
    try {
      const newPaper = await api.findPaper(profile.id, manualPaperTitle);
      mergePaper(newPaper);
      setSelectedPaperIds(prev => new Set(prev).add(newPaper.id));
      setManualPaperTitle('');
    } catch (error: any) {
      alert(error.message || 'Failed to add paper.');
    } finally {
      setAppState(AppState.READY);
    }
  };

  /** The server owns the pipeline; this only streams progress back into state. */
  const runPipeline = useCallback(async (ids: string[]) => {
    if (!profile || !ids.length) return;
    try {
      await api.processPapers(profile.id, ids, mergePaper, undefined, message => alert(message));
    } catch (error: any) {
      console.error(error);
      alert(error.message || 'Processing failed.');
    }
  }, [profile, mergePaper]);

  const handleToggleSelect = (id: string) => {
    setSelectedPaperIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    const allIds = papers.map(p => p.id);
    if (selectedPaperIds.size === allIds.length) setSelectedPaperIds(new Set());
    else setSelectedPaperIds(new Set(allIds));
  };

  const handleGenerateSelected = () => {
    runPipeline(papers.filter(p => selectedPaperIds.has(p.id)).map(p => p.id));
  };

  const handleFetchCitations = async (paper: Paper) => {
    if (!profile) return;
    if (paper.citingPapers && paper.citingPapers.length > 0) return;
    try {
      const citingPapers = await api.fetchCitations(profile.id, paper.id);
      mergePaper({ ...paper, citingPapers });
    } catch (e) {
      console.error("Failed to fetch citations", e);
    }
  };

  const updateBotMessage = (id: string, content: string, isStreaming: boolean = false) => {
    setChatMessages(prev => prev.map(msg =>
      msg.id === id ? { ...msg, content, isStreaming } : msg
    ));
  };

  const handleSendMessage = useCallback(async (text: string, useWebSearch = false) => {
    if (!profile) return;

    const newUserMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: Date.now()
    };

    setChatMessages(prev => [...prev, newUserMsg]);
    setIsChatProcessing(true);
    api.appendMessage(profile.id, newUserMsg).catch(console.error);

    const botMsgId = (Date.now() + 1).toString();
    setChatMessages(prev => [...prev, {
      id: botMsgId,
      role: 'model',
      content: 'Thinking...',
      timestamp: Date.now(),
      isStreaming: true
    }]);

    const analyzeMatch = text.match(/^analyze\s+(.+)/i);
    if (analyzeMatch) {
      const query = analyzeMatch[1];
      try {
        updateBotMessage(botMsgId, `Searching for paper: "${query}"...`, true);
        const newPaper = await api.findPaper(profile.id, query);
        mergePaper(newPaper);
        updateBotMessage(botMsgId, `Found "${newPaper.title}". Generating resources...`, true);
        await runPipeline([newPaper.id]);
        updateBotMessage(botMsgId, `Successfully analyzed "${newPaper.title}". You can now read the blog or ask questions about it.`, false);
      } catch (e: any) {
        updateBotMessage(botMsgId, e.message || 'Error processing request.', false);
      } finally {
        setIsChatProcessing(false);
      }
      return;
    }

    let fullResponse = "";
    try {
      await api.streamChat(
        profile.id,
        text,
        useWebSearch,
        chunk => {
          fullResponse += chunk;
          updateBotMessage(botMsgId, fullResponse, true);
        },
        undefined,
        message => { fullResponse = fullResponse || `[${message}]`; }
      );
    } catch (e: any) {
      fullResponse = fullResponse || `[${e.message || 'Chat failed'}]`;
    }

    updateBotMessage(botMsgId, fullResponse, false);
    setIsChatProcessing(false);
    api.appendMessage(profile.id, {
      id: botMsgId, role: 'model', content: fullResponse, timestamp: Date.now(),
    }).catch(console.error);
  }, [profile, mergePaper, runPipeline]);

  if (loadError) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center gap-4 bg-slate-50 text-center px-6">
        <p className="text-slate-800 font-semibold">Could not load this profile.</p>
        <p className="text-slate-500 text-sm max-w-md">{loadError}</p>
        <button onClick={onBack} className="px-4 py-2 rounded-lg bg-scholarly-600 text-white text-sm font-medium">
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-50">
        <Loader2 className="w-6 h-6 text-scholarly-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-slate-50 overflow-hidden font-sans transition-colors duration-500 relative">
      
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
         <div className="absolute -top-40 -left-40 w-96 h-96 bg-scholarly-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob"></div>
         <div className="absolute top-0 -right-20 w-96 h-96 bg-purple-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-2000"></div>
         <div className="absolute -bottom-40 left-20 w-96 h-96 bg-pink-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-4000"></div>
      </div>

      {/* Left Panel: Dashboard & Papers */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative z-10">
        
        {/* Header/Input Area */}
        <div className="glass-panel p-6 md:p-8 border-b border-white/40 shadow-sm z-20">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <button 
                onClick={onBack}
                className="p-2 -ml-2 rounded-full hover:bg-black/5 transition-colors shrink-0"
                title="Back to Dashboard"
              >
                 <ArrowLeft className="w-5 h-5 text-slate-700" />
              </button>
              <div className="bg-gradient-to-br from-scholarly-500 to-scholarly-700 p-2.5 rounded-xl shadow-lg shadow-scholarly-200/50 shrink-0">
                <span className="text-xl leading-none flex items-center justify-center h-6 w-6">{profile.emoji}</span>
              </div>
              <div className="flex-1 min-w-0 group">
                 <div className="relative">
                    <input 
                        type="text" 
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="text-xl font-serif font-bold text-slate-900 tracking-tight leading-none bg-transparent border-none focus:ring-0 p-0 w-full placeholder:text-slate-400 focus:outline-none"
                        placeholder="Untitled Profile"
                    />
                    <Edit3 className="w-3.5 h-3.5 text-slate-400 absolute -right-4 top-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                 </div>
                 <p className="text-xs text-slate-500 font-medium mt-1">Edited {new Date(profile.updatedAt).toLocaleTimeString()}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 ml-4">
              {/* Clear Session Button */}
              {(scholar || chatMessages.length > 0) && (
                <button
                  onClick={handleClearSession}
                  className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                  title="Clear Papers & Chat"
                >
                  <Eraser className="w-5 h-5" />
                </button>
              )}
              
              {/* Delete Profile Button */}
              <button
                  onClick={handleDeleteProfile}
                  className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
                  title="Delete Profile"
              >
                  <Trash2 className="w-5 h-5" />
              </button>

              {/* Theme Picker */}
              <div className="relative">
                <button 
                  onClick={() => setShowThemePicker(!showThemePicker)}
                  className="p-2 rounded-lg hover:bg-white/50 text-slate-600 transition-colors"
                  title="Change Theme"
                >
                  <Palette className="w-5 h-5" />
                </button>
                
                {showThemePicker && (
                  <div className="absolute right-0 top-full mt-2 bg-white rounded-xl shadow-xl border border-slate-100 p-2 min-w-[140px] animate-in fade-in zoom-in-95 duration-200 z-50">
                    <div className="text-xs font-bold text-slate-400 px-2 py-1 uppercase tracking-wider mb-1">Theme</div>
                    {Object.keys(THEMES).map((theme) => (
                      <button
                        key={theme}
                        onClick={() => { setCurrentTheme(theme as ThemeName); setShowThemePicker(false); }}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${currentTheme === theme ? 'bg-scholarly-50 text-scholarly-700' : 'hover:bg-slate-50 text-slate-600'}`}
                      >
                        <div className={`w-3 h-3 rounded-full bg-${theme === 'Ocean' ? 'sky' : theme === 'Violet' ? 'violet' : theme === 'Emerald' ? 'emerald' : theme === 'Rose' ? 'rose' : 'amber'}-500`} style={{ backgroundColor: `rgb(${THEMES[theme as ThemeName][500]})` }}></div>
                        {theme}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Toggle for Data Addition */}
          <div className="flex bg-slate-100/50 p-1 rounded-xl mb-4 w-fit border border-white/20">
             <button
               onClick={() => setInputMode('search')}
               className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'search' ? 'bg-white text-scholarly-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
             >
               <Search className="w-4 h-4" /> Search Scholar
             </button>
             <button
               onClick={() => setInputMode('add')}
               className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'add' ? 'bg-white text-scholarly-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
             >
               <FilePlus className="w-4 h-4" /> Add Paper
             </button>
          </div>

          {/* Input Form Area */}
          <div className="relative max-w-3xl">
             {inputMode === 'search' ? (
                <form onSubmit={handleSearch} className="animate-in fade-in duration-300">
                    <input
                    type="text"
                    value={scholarName}
                    onChange={(e) => setScholarName(e.target.value)}
                    placeholder="Enter scholar name or Google Scholar profile URL..."
                    className="w-full pl-6 pr-14 py-4 rounded-2xl border-0 ring-1 ring-slate-200 shadow-lg shadow-slate-200/40 focus:ring-2 focus:ring-scholarly-400 focus:shadow-scholarly-100/50 outline-none transition-all text-lg bg-white/80 backdrop-blur-sm"
                    disabled={appState === AppState.SEARCHING}
                    />
                    <button 
                    type="submit" 
                    disabled={appState === AppState.SEARCHING}
                    className="absolute right-2 top-2 bottom-2 bg-scholarly-600 text-white rounded-xl px-5 hover:bg-scholarly-700 transition-all disabled:bg-slate-300 disabled:shadow-none shadow-md shadow-scholarly-300 hover:shadow-lg hover:scale-105 active:scale-95 flex items-center justify-center"
                    >
                    {appState === AppState.SEARCHING ? (
                        <Activity className="w-5 h-5 animate-spin" />
                    ) : (
                        <ArrowRight className="w-5 h-5" />
                    )}
                    </button>
                </form>
             ) : (
                <form onSubmit={handleManualAdd} className="animate-in fade-in duration-300">
                    <input
                    type="text"
                    value={manualPaperTitle}
                    onChange={(e) => setManualPaperTitle(e.target.value)}
                    placeholder="Enter specific paper title or topic to add..."
                    className="w-full pl-6 pr-32 py-4 rounded-2xl border-0 ring-1 ring-slate-200 shadow-lg shadow-slate-200/40 focus:ring-2 focus:ring-scholarly-400 focus:shadow-scholarly-100/50 outline-none transition-all text-lg bg-white/80 backdrop-blur-sm"
                    disabled={appState === AppState.SEARCHING}
                    />
                    <button 
                    type="submit" 
                    disabled={appState === AppState.SEARCHING}
                    className="absolute right-2 top-2 bottom-2 bg-scholarly-600 text-white rounded-xl px-5 hover:bg-scholarly-700 transition-all disabled:bg-slate-300 disabled:shadow-none shadow-md shadow-scholarly-300 hover:shadow-lg hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
                    >
                    {appState === AppState.SEARCHING ? (
                        <Activity className="w-5 h-5 animate-spin" />
                    ) : (
                        <>
                           <Plus className="w-5 h-5" />
                           <span className="font-medium">Add</span>
                        </>
                    )}
                    </button>
                </form>
             )}
          </div>

          {/* Scholar Stats */}
          {scholar && (
            <div className="mt-6 flex flex-wrap gap-3 animate-in fade-in slide-in-from-top-4 duration-500">
               <div className="bg-white/60 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/50 shadow-sm text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <span className="text-xl">🏛️</span> {scholar.affiliation || "Library Collection"}
               </div>
               {scholar.topics?.map(topic => (
                 <div key={topic} className="bg-scholarly-50/80 backdrop-blur-sm px-3 py-2 rounded-lg border border-scholarly-100 text-sm font-medium text-scholarly-700">
                   #{topic}
                 </div>
               ))}
               <div className="bg-purple-50/80 backdrop-blur-sm px-4 py-2 rounded-lg border border-purple-100 text-sm font-medium text-purple-700 flex items-center gap-2">
                 📚 {scholar.papers.length} Papers
               </div>
                <div className="bg-emerald-50/80 backdrop-blur-sm px-4 py-2 rounded-lg border border-emerald-100 text-sm font-medium text-emerald-700 flex items-center gap-2">
                 <Save className="w-4 h-4" /> Auto-Saved
               </div>
            </div>
          )}
        </div>

        {/* Papers Scroll Area */}
        <div className="flex-1 overflow-y-auto p-6 md:p-8 scroll-smooth">
          <PaperList 
            papers={scholar?.papers || []} 
            selectedIds={selectedPaperIds}
            onToggleSelect={handleToggleSelect}
            onSelectAll={handleSelectAll}
            onGenerate={handleGenerateSelected}
            onReadBlog={setActivePaper} 
            onFetchCitations={handleFetchCitations}
          />
        </div>

        {/* Floating status (Processing) */}
        {isAnyProcessing && (
           <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-slate-900/80 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 text-sm backdrop-blur-md z-30 animate-in fade-in slide-in-from-bottom-8 border border-white/10">
             <div className="relative flex items-center justify-center">
                <span className="absolute w-full h-full bg-scholarly-500 rounded-full animate-ping opacity-50"></span>
                <Activity className="relative w-4 h-4 text-scholarly-400" />
             </div>
             <span className="font-medium tracking-wide">Generating Assets (Async)...</span>
           </div>
        )}
      </div>

      {/* Right Panel: Chat */}
      <div className={`
        fixed md:static inset-y-0 right-0 z-40 bg-white/80 backdrop-blur-xl shadow-2xl md:shadow-none md:bg-transparent
        transition-all duration-500 ease-in-out border-l border-white/20
        ${isChatOpen ? 'translate-x-0 w-full md:w-[420px] lg:w-[480px] opacity-100' : 'translate-x-full w-0 md:w-0 opacity-0 overflow-hidden'}
      `}>
         <div className="w-full h-full min-w-[320px] bg-white/80 backdrop-blur-xl md:shadow-2xl">
            <ChatInterface 
                messages={chatMessages} 
                onSendMessage={handleSendMessage}
                isProcessing={isChatProcessing}
                readyToChat={true}
                onClose={() => setIsChatOpen(false)}
            />
         </div>
      </div>
      
      {/* Floating Action Button (Open Chat) */}
      {!isChatOpen && (
         <button
            onClick={() => setIsChatOpen(true)}
            className="fixed bottom-6 right-6 p-4 bg-scholarly-600 text-white rounded-full shadow-xl shadow-scholarly-300 hover:bg-scholarly-700 hover:scale-110 active:scale-95 transition-all z-50 animate-in zoom-in slide-in-from-bottom-4 duration-300 group"
         >
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white"></div>
            <MessageSquare className="w-6 h-6 group-hover:rotate-12 transition-transform" />
            <span className="sr-only">Open Chat</span>
         </button>
      )}

      {/* Blog Modal */}
      {activePaper && (
        <BlogReader 
          paper={activePaper} 
          onClose={() => setActivePaper(null)} 
        />
      )}

    </div>
  );
};

export default ProfileWorkspace;