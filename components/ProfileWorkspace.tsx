import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { GraduationCap, ArrowRight, Activity, Palette, Sparkles, Plus, Search, Eraser, Trash2, Save, FilePlus, MessageSquare, ArrowLeft, Edit3, Loader2, Link2, Upload, Sun, Moon } from 'lucide-react';
import { Citation, Paper, Message, ScholarData, AppState } from '../types';
import { Theme } from './theme';
import * as api from '../services/api';
import PaperList from './PaperList';
import BlogReader from './BlogReader';
import CiteDialog from './CiteDialog';
import ChatInterface from './ChatInterface';


interface ProfileWorkspaceProps {
  profileId: string;
  onBack: () => void;
  onDelete: () => void;
  /** Switches to an existing profile — used when a search turns out to duplicate one. */
  onOpenProfile: (id: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

const ProfileWorkspace: React.FC<ProfileWorkspaceProps> = ({ profileId, onBack, onDelete, onOpenProfile, theme, onToggleTheme }) => {
  // Server-owned state
  const [profile, setProfile] = useState<api.ProfileRecord | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');

  const [scholarName, setScholarName] = useState('');
  const [manualPaperTitle, setManualPaperTitle] = useState('');
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [activePaper, setActivePaper] = useState<Paper | null>(null);
  const [citingPaper, setCitingPaper] = useState<Paper | null>(null);
  const [isChatProcessing, setIsChatProcessing] = useState(false);

  // UI States
  const [inputMode, setInputMode] = useState<'search' | 'add' | 'source'>('search');
  const [sourceUrl, setSourceUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isChatOpen, setIsChatOpen] = useState(true);

  // Selection State
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<string>>(new Set());

  // The current batch: which papers, and which half of the pipeline is running.
  const [batch, setBatch] = useState<{ ids: string[]; mode: api.PipelineMode } | null>(null);

  // The run the server is executing on our behalf, and how far it has got.
  // Processing outlives this component now, so this is polled rather than
  // streamed — closing the tab no longer cancels anything.
  const [run, setRun] = useState<api.Run | null>(null);
  const [runProgress, setRunProgress] = useState<api.RunProgress | null>(null);

  // A crawl can only discover the second kind of duplicate after the model has
  // resolved the scholar's real name, which happens inside the job. The run
  // reports it; this carries it out of the poller and into the prompt below.
  const [pendingDuplicate, setPendingDuplicate] = useState<api.DuplicateProfile | null>(null);

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
  const savedRef = useRef({ title: '' });
  useEffect(() => {
    if (!profile) return;
    if (savedRef.current.title === title) return;
    const handle = setTimeout(() => {
      savedRef.current = { title };
      api.updateProfile(profile.id, { title }).catch(console.error);
    }, 600);
    return () => clearTimeout(handle);
  }, [title, profile]);

  // The server names an untitled profile after the scholar it resolved, so adopt
  // that. Guarded against a raw URL ever becoming the title.
  const looksLikeUrl = (value: string) => /^(https?:|www\.)|scholar\.google/i.test(value.trim());

  useEffect(() => {
    if (!profile) return;
    const candidate = profile.title && profile.title !== 'Untitled profile'
      ? profile.title
      : profile.scholarName;
    if (!candidate || looksLikeUrl(candidate)) return;
    if (!title || title === 'Untitled profile') setTitle(candidate);
  }, [profile?.title, profile?.scholarName]);


  const isBusy = useCallback(
    (p: Paper) =>
      p.status === 'downloading' || p.status === 'processing' || p.indexStatus === 'indexing',
    []
  );

  /**
   * A run that is queued but not yet claimed shows nothing on any paper, so the
   * run itself has to count as busy — otherwise the UI looks idle for the
   * second or two before a worker picks the job up.
   */
  const isAnyProcessing = useMemo(
    () => papers.some(isBusy) || (!!run && !api.isRunFinished(run)),
    [papers, isBusy, run]
  );

  const batchProgress = useMemo(() => {
    const label = batch?.mode === 'index' ? 'Indexing' : run?.kind === 'crawl' ? 'Crawling' : 'Processing';

    // The queue counts settled jobs directly, which is both cheaper and more
    // accurate than inferring completion from paper fields — a job that
    // dead-lettered is done, even though its paper never reached 'converted'.
    if (runProgress?.total) {
      const done = runProgress.succeeded + runProgress.failed;
      return {
        done,
        total: runProgress.total,
        percent: (done / runProgress.total) * 100,
        label,
      };
    }

    if (!batch?.ids.length) return null;
    const inBatch = papers.filter(p => batch.ids.includes(p.id));
    const settled = inBatch.filter(p => !isBusy(p)).length;
    return {
      done: settled,
      total: batch.ids.length,
      percent: (settled / batch.ids.length) * 100,
      label,
    };
  }, [papers, batch, isBusy, run, runProgress]);

  /**
   * Polls whatever run is outstanding.
   *
   * The work is a queued job on the server, so it survives a reload, a
   * navigation and a dropped connection — and equally, it keeps going when this
   * component is not watching. Picking the run up again on mount is therefore
   * the normal case, not an error path.
   */
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const status = await api.profileStatus(profile.id);
        if (cancelled) return;
        setRun(status.run);
        setRunProgress(status.progress);

        // The status response carries per-paper state; the papers themselves
        // carry the content. Refresh both while anything is moving.
        if (status.run && !api.isRunFinished(status.run)) {
          const fresh = await api.listPapers(profile.id);
          if (!cancelled) setPapers(fresh);
        } else if (status.run && api.isRunFinished(status.run)) {
          const fresh = await api.listPapers(profile.id);
          if (!cancelled) setPapers(fresh);
          if (!cancelled) setBatch(null);

          // A crawl that stopped because the scholar is already in a library
          // reports itself here: the check needs the resolved name, which only
          // exists after the model call, so it cannot be answered by the
          // request that started it.
          const duplicate = status.run.detail?.duplicate;
          if (duplicate && status.run.status === 'cancelled') {
            setPendingDuplicate(duplicate);
          }
          return; // Settled: stop polling until something else is started.
        }
      } catch {
        // Transient failure: the next tick tries again.
      }
      if (!cancelled) handle = setTimeout(tick, 2000);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [profile?.id, run?.id]);

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

  const runSearch = async (query: string, allowDuplicate: boolean) => {
    if (!profile) return;
    const { runId, profile: updated } = await api.searchScholar(profile.id, query, allowDuplicate);
    setProfile(updated);
    if (updated.title && !looksLikeUrl(updated.title)) {
      setTitle(updated.title);
      savedRef.current = { title: updated.title };
    }

    // The papers do not exist yet — the crawl has only just been queued. The
    // poller fills them in as the worker finds and indexes them.
    if (runId) {
      const { run: started, progress } = await api.getRun(runId);
      setRun(started);
      setRunProgress(progress);
    }
    setAppState(AppState.READY);
  };

  /**
   * The server refuses a search that would build a second library for a scholar
   * the user already has. Offer the existing one — a duplicate means a second
   * store, a second set of embeddings and a split chat history — but let them
   * override, because two libraries for one scholar is a legitimate thing to want.
   */
  const handleDuplicate = async (duplicate: api.DuplicateProfile) => {
    const name = duplicate.scholarName || duplicate.title;
    const openExisting = window.confirm(
      `You already have a library for ${name}: "${duplicate.title}", ` +
        `with ${duplicate.paperCount} paper${duplicate.paperCount === 1 ? '' : 's'}.\n\n` +
        `OK — open that library instead.\n` +
        `Cancel — build a second, separate library for the same scholar.`
    );

    if (!openExisting) {
      await runSearch(scholarName, true);
      return;
    }

    // This profile was created moments ago for a search that is not happening.
    // Discard it rather than leaving an empty shell and an unused store behind.
    if (profile && !papers.length && !chatMessages.length) {
      api.deleteProfile(profile.id).catch(console.error);
    }
    onOpenProfile(duplicate.id);
  };

  // The 409 path and the run-reported path converge on the same prompt.
  useEffect(() => {
    if (!pendingDuplicate) return;
    const duplicate = pendingDuplicate;
    setPendingDuplicate(null);
    setAppState(AppState.IDLE);
    handleDuplicate(duplicate).catch(error => {
      alert(error?.message || 'Failed to find scholar info. Please try again.');
    });
  }, [pendingDuplicate]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scholarName.trim() || !profile) return;

    setAppState(AppState.SEARCHING);
    setSelectedPaperIds(new Set());

    try {
      await runSearch(scholarName, false);
    } catch (error: any) {
      const duplicate = error?.data?.duplicate as api.DuplicateProfile | undefined;
      if (duplicate) {
        try {
          await handleDuplicate(duplicate);
        } catch (retryError: any) {
          setAppState(AppState.IDLE);
          alert(retryError.message || 'Failed to find scholar info. Please try again.');
        }
        return;
      }
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

  /**
   * Enqueues the pipeline and hands over to the poller. Nothing is awaited to
   * completion here: a sixty-paper crawl takes minutes, and the user is free to
   * navigate away, reload or close the tab while it runs.
   */
  const runPipeline = useCallback(async (ids: string[], mode: api.PipelineMode) => {
    if (!profile || !ids.length) return;
    setBatch({ ids, mode });
    try {
      const { runId, alreadyRunning } = await api.processPapers(profile.id, ids, mode);
      if (!runId) {
        setBatch(null);
        return;
      }
      if (alreadyRunning) {
        // Asking twice is idempotent; join the run already doing the work.
        console.info('Those papers are already being processed; watching that run.');
      }
      const { run: started, progress } = await api.getRun(runId);
      setRun(started);
      setRunProgress(progress);
    } catch (error: any) {
      console.error(error);
      alert(error.message || 'Processing failed.');
      setBatch(null);
    }
  }, [profile]);

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

  const selectedIds = () => papers.filter(p => selectedPaperIds.has(p.id)).map(p => p.id);

  const handleIndexSelected = () => runPipeline(selectedIds(), 'index');
  const handleGenerateSelected = () => runPipeline(selectedIds(), 'artifacts');

  /** Any link: a page, a Wikipedia article, a YouTube video, a PDF. */
  const handleAddSourceUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceUrl.trim() || !profile) return;
    setAppState(AppState.SEARCHING);
    try {
      const added = await api.addSourceUrl(profile.id, sourceUrl);
      mergePaper(added);
      setSelectedPaperIds(prev => new Set(prev).add(added.id));
      setSourceUrl('');
    } catch (error: any) {
      alert(error.message || 'Could not read that link.');
    } finally {
      setAppState(AppState.READY);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file twice still fires a change.
    e.target.value = '';
    if (!file || !profile) return;

    setUploading(true);
    try {
      const added = await api.uploadSource(profile.id, file);
      mergePaper(added);
      setSelectedPaperIds(prev => new Set(prev).add(added.id));
    } catch (error: any) {
      alert(error.message || 'Could not read that file.');
    } finally {
      setUploading(false);
    }
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

  const attachCitations = (id: string, citations: Citation[]) => {
    setChatMessages(prev => prev.map(msg => (msg.id === id ? { ...msg, citations } : msg)));
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
        await runPipeline([newPaper.id], 'both');
        updateBotMessage(botMsgId, `Successfully analyzed "${newPaper.title}". You can now read the blog or ask questions about it.`, false);
      } catch (e: any) {
        updateBotMessage(botMsgId, e.message || 'Error processing request.', false);
      } finally {
        setIsChatProcessing(false);
      }
      return;
    }

    let fullResponse = "";
    let citations: Citation[] = [];
    try {
      await api.streamChat(
        profile.id,
        text,
        useWebSearch,
        chunk => {
          fullResponse += chunk;
          updateBotMessage(botMsgId, fullResponse, true);
        },
        info => {
          // Say plainly that nothing is indexed yet, rather than letting the
          // model report an empty library as if the question were unanswerable.
          if (info?.fellBack && info.pending) {
            fullResponse +=
              `\n\n---\n*Answered from the web: none of your ${info.pending} papers are indexed yet. ` +
              `Select them and press **Index** to make them searchable.*`;
          }
        },
        message => { fullResponse = fullResponse || `[${message}]`; },
        received => { citations = received; attachCitations(botMsgId, received); }
      );
    } catch (e: any) {
      fullResponse = fullResponse || `[${e.message || 'Chat failed'}]`;
    }

    updateBotMessage(botMsgId, fullResponse, false);
    setIsChatProcessing(false);
    api.appendMessage(profile.id, {
      id: botMsgId, role: 'model', content: fullResponse, timestamp: Date.now(), citations,
    }).catch(console.error);
  }, [profile, mergePaper, runPipeline]);

  if (loadError) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center gap-4 bg-surface text-center px-6">
        <p className="text-ink font-semibold">Could not load this profile.</p>
        <p className="text-muted text-sm max-w-md">{loadError}</p>
        <button onClick={onBack} className="px-4 py-2 rounded-lg bg-scholarly-600 text-white text-sm font-medium">
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-surface">
        <Loader2 className="w-6 h-6 text-scholarly-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-surface overflow-hidden font-sans transition-colors duration-500 relative">
      
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
         <div className="absolute -top-40 -left-40 w-96 h-96 bg-scholarly-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob"></div>
         <div className="absolute top-0 -right-20 w-96 h-96 bg-purple-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-2000"></div>
         <div className="absolute -bottom-40 left-20 w-96 h-96 bg-pink-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-4000"></div>
      </div>

      {/* Left Panel: Dashboard & Papers */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative z-10">
        
        {/* Header/Input Area */}
        <div className="glass-panel p-6 md:p-8 border-b border-line/40 shadow-sm z-20">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <button 
                onClick={onBack}
                className="p-2 -ml-2 rounded-full hover:bg-black/5 transition-colors shrink-0"
                title="Back to Dashboard"
              >
                 <ArrowLeft className="w-5 h-5 text-ink" />
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
                        className="text-xl font-serif font-bold text-ink tracking-tight leading-none bg-transparent border-none focus:ring-0 p-0 w-full placeholder:text-subtle focus:outline-none"
                        placeholder="Untitled Profile"
                    />
                    <Edit3 className="w-3.5 h-3.5 text-subtle absolute -right-4 top-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                 </div>
                 <p className="text-xs text-muted font-medium mt-1">Edited {new Date(profile.updatedAt).toLocaleTimeString()}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 ml-4">
              {/* Clear Session Button */}
              {(scholar || chatMessages.length > 0) && (
                <button
                  onClick={handleClearSession}
                  className="p-2 rounded-lg hover:bg-panel-2 text-subtle hover:text-ink transition-colors"
                  title="Clear Papers & Chat"
                >
                  <Eraser className="w-5 h-5" />
                </button>
              )}
              
              {/* Delete Profile Button */}
              <button
                  onClick={handleDeleteProfile}
                  className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/15 text-subtle hover:text-red-500 dark:hover:text-red-300 transition-colors"
                  title="Delete Profile"
              >
                  <Trash2 className="w-5 h-5" />
              </button>

              {/* Light / dark */}
              <button
                onClick={onToggleTheme}
                className="p-2 rounded-lg hover:bg-panel-2 text-muted hover:text-ink transition-colors"
                title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              >
                {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Toggle for Data Addition */}
          <div className="flex bg-panel-2/50 p-1 rounded-xl mb-4 w-fit border border-line/20">
             <button
               onClick={() => setInputMode('search')}
               className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'search' ? 'bg-panel text-scholarly-700 shadow-sm' : 'text-muted hover:text-ink'}`}
             >
               <Search className="w-4 h-4" /> Search Scholar
             </button>
             <button
               onClick={() => setInputMode('add')}
               className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'add' ? 'bg-panel text-scholarly-700 shadow-sm' : 'text-muted hover:text-ink'}`}
             >
               <FilePlus className="w-4 h-4" /> Add Paper
             </button>
             <button
               onClick={() => setInputMode('source')}
               className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'source' ? 'bg-panel text-scholarly-700 shadow-sm' : 'text-muted hover:text-ink'}`}
             >
               <Link2 className="w-4 h-4" /> Add Source
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
                    className="w-full pl-6 pr-14 py-4 rounded-2xl border-0 ring-1 ring-line shadow-lg shadow-black/5 dark:shadow-black/40 focus:ring-2 focus:ring-scholarly-400 focus:shadow-scholarly-100/50 outline-none transition-all text-lg bg-panel/80 backdrop-blur-sm"
                    disabled={appState === AppState.SEARCHING}
                    />
                    <button 
                    type="submit" 
                    disabled={appState === AppState.SEARCHING}
                    className="absolute right-2 top-2 bottom-2 bg-scholarly-600 text-white rounded-xl px-5 hover:bg-scholarly-700 transition-all disabled:bg-line disabled:shadow-none shadow-md shadow-scholarly-300 hover:shadow-lg hover:scale-105 active:scale-95 flex items-center justify-center"
                    >
                    {appState === AppState.SEARCHING ? (
                        <Activity className="w-5 h-5 animate-spin" />
                    ) : (
                        <ArrowRight className="w-5 h-5" />
                    )}
                    </button>
                </form>
             ) : inputMode === 'source' ? (
                <div className="animate-in fade-in duration-300 space-y-3">
                  <form onSubmit={handleAddSourceUrl} className="relative">
                    <input
                      type="text"
                      value={sourceUrl}
                      onChange={(e) => setSourceUrl(e.target.value)}
                      placeholder="Paste a link — YouTube, Wikipedia, an article, a PDF..."
                      className="w-full pl-6 pr-32 py-4 rounded-2xl border-0 ring-1 ring-line shadow-lg shadow-black/5 dark:shadow-black/40 focus:ring-2 focus:ring-scholarly-400 focus:shadow-scholarly-100/50 outline-none transition-all text-lg bg-panel/80 backdrop-blur-sm"
                      disabled={appState === AppState.SEARCHING || uploading}
                    />
                    <button
                      type="submit"
                      disabled={appState === AppState.SEARCHING || uploading}
                      className="absolute right-2 top-2 bottom-2 bg-scholarly-600 text-white rounded-xl px-5 hover:bg-scholarly-700 transition-all disabled:bg-line disabled:shadow-none shadow-md shadow-scholarly-300 hover:shadow-lg hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
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

                  <div className="flex items-center gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || appState === AppState.SEARCHING}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-panel border border-line text-ink font-semibold hover:bg-surface hover:border-line transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {uploading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" /> Reading the file...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4" /> Upload a file
                        </>
                      )}
                    </button>
                    <span className="text-muted">
                      PDF, text, audio or video — up to 50MB. It is read once and then searchable.
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      accept="application/pdf,text/plain,text/markdown,text/csv,audio/*,video/*"
                      onChange={handleUpload}
                    />
                  </div>
                </div>
             ) : (
                <form onSubmit={handleManualAdd} className="animate-in fade-in duration-300">
                    <input
                    type="text"
                    value={manualPaperTitle}
                    onChange={(e) => setManualPaperTitle(e.target.value)}
                    placeholder="Enter specific paper title or topic to add..."
                    className="w-full pl-6 pr-32 py-4 rounded-2xl border-0 ring-1 ring-line shadow-lg shadow-black/5 dark:shadow-black/40 focus:ring-2 focus:ring-scholarly-400 focus:shadow-scholarly-100/50 outline-none transition-all text-lg bg-panel/80 backdrop-blur-sm"
                    disabled={appState === AppState.SEARCHING}
                    />
                    <button 
                    type="submit" 
                    disabled={appState === AppState.SEARCHING}
                    className="absolute right-2 top-2 bottom-2 bg-scholarly-600 text-white rounded-xl px-5 hover:bg-scholarly-700 transition-all disabled:bg-line disabled:shadow-none shadow-md shadow-scholarly-300 hover:shadow-lg hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
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
               <div className="bg-panel/60 backdrop-blur-sm px-4 py-2 rounded-lg border border-line/50 shadow-sm text-sm font-semibold text-ink flex items-center gap-2">
                  <span className="text-xl">🏛️</span> {scholar.affiliation || "Library Collection"}
               </div>
               {scholar.topics?.map(topic => (
                 <div key={topic} className="bg-scholarly-50/80 backdrop-blur-sm px-3 py-2 rounded-lg border border-scholarly-100 text-sm font-medium text-scholarly-700">
                   #{topic}
                 </div>
               ))}
               <div className="bg-purple-50 dark:bg-purple-500/15/80 backdrop-blur-sm px-4 py-2 rounded-lg border border-purple-100 text-sm font-medium text-purple-700 dark:text-purple-300 flex items-center gap-2">
                 📚 {scholar.papers.length} Papers
               </div>
                <div className="bg-emerald-50 dark:bg-emerald-500/15/80 backdrop-blur-sm px-4 py-2 rounded-lg border border-emerald-100 text-sm font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
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
            onIndex={handleIndexSelected}
            onGenerate={handleGenerateSelected}
            busy={isAnyProcessing}
            onReadBlog={setActivePaper} 
            onFetchCitations={handleFetchCitations}
            onCite={setCitingPaper}
          />
        </div>

        {/* Floating status: real batch progress while the pipeline runs */}
        {isAnyProcessing && (
           <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-[min(92vw,26rem)] bg-slate-900/85 text-white px-5 py-4 rounded-2xl shadow-2xl backdrop-blur-md z-30 animate-in fade-in slide-in-from-bottom-8 border border-line/10">
             <div className="flex items-center gap-3">
                <div className="relative flex items-center justify-center shrink-0">
                   <span className="absolute w-full h-full bg-scholarly-500 rounded-full animate-ping opacity-50"></span>
                   <Activity className="relative w-4 h-4 text-scholarly-400" />
                </div>
                <span className="font-medium tracking-wide text-sm flex-1 min-w-0">
                  {batchProgress
                    ? `${batchProgress.label} ${batchProgress.done} of ${batchProgress.total} papers`
                    : 'Working…'}
                </span>
                {batchProgress && (
                  <span className="text-xs font-mono text-scholarly-300 tabular-nums shrink-0">
                    {Math.round(batchProgress.percent)}%
                  </span>
                )}
             </div>

             {batchProgress && (
               <div className="mt-3 h-1.5 w-full bg-panel/15 rounded-full overflow-hidden">
                 <div
                   className="h-full bg-gradient-to-r from-scholarly-400 to-scholarly-200 rounded-full transition-all duration-500 ease-out"
                   style={{ width: `${Math.max(batchProgress.percent, 3)}%` }}
                 />
               </div>
             )}

             {/* What each in-flight paper is doing right now. */}
             <div className="mt-3 space-y-1.5 max-h-24 overflow-y-auto">
               {papers
                 .filter(isBusy)
                 .slice(0, 3)
                 .map(p => (
                   <div key={p.id} className="flex items-center gap-2 text-xs text-white/70">
                     <Loader2 className="w-3 h-3 animate-spin shrink-0 text-scholarly-300" />
                     <span className="truncate flex-1">{p.title}</span>
                     <span className="text-white/50 shrink-0">
                       {p.stage === 'resolving' ? 'finding'
                         : p.stage === 'fetching' ? 'downloading'
                         : p.stage === 'indexing' ? 'indexing'
                         : p.stage === 'writing' ? 'writing'
                         : p.stage === 'media' ? 'audio & art'
                         : 'working'}
                     </span>
                   </div>
                 ))}
             </div>
           </div>
        )}
      </div>

      {/* Right Panel: Chat */}
      <div className={`
        fixed md:static inset-y-0 right-0 z-40 bg-panel/80 backdrop-blur-xl shadow-2xl md:shadow-none md:bg-transparent
        transition-all duration-500 ease-in-out border-l border-line/20
        ${isChatOpen ? 'translate-x-0 w-full md:w-[420px] lg:w-[480px] opacity-100' : 'translate-x-full w-0 md:w-0 opacity-0 overflow-hidden'}
      `}>
         <div className="w-full h-full min-w-[320px] bg-panel/80 backdrop-blur-xl md:shadow-2xl">
            <ChatInterface 
                messages={chatMessages} 
                onSendMessage={handleSendMessage}
                indexedCount={papers.filter(p => p.fileSearchDocName).length}
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
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-line"></div>
            <MessageSquare className="w-6 h-6 group-hover:rotate-12 transition-transform" />
            <span className="sr-only">Open Chat</span>
         </button>
      )}

      {citingPaper && (
        <CiteDialog
          profileId={profile.id}
          paperId={citingPaper.id}
          onClose={() => setCitingPaper(null)}
        />
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