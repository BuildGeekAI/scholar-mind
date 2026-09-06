import React, { useState, useMemo } from 'react';
import { Paper } from '../types';
import { FileText, Loader2, CheckCircle, AlertCircle, BookOpen, MonitorPlay, Play, Filter, X, Sparkles, Square, Quote, ChevronDown, ChevronUp, CheckSquare, Square as SquareIcon, Wand2, Database, Youtube, Globe, Library, Mic, Video, FileType } from 'lucide-react';
import { playAudioUrl, stopAudio } from '../utils/audio';
import { blobUrl } from '../services/api';

interface PaperListProps {
  papers: Paper[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  /** Embeds the paper into the profile's search index, for grounded chat. */
  onIndex: () => void;
  /** Writes the blog, slides, quiz, flashcards, audio and illustration. */
  onGenerate: () => void;
  busy: boolean;
  onReadBlog: (paper: Paper) => void;
  onFetchCitations: (paper: Paper) => void;
}

type Stage = { label: string; percent: number };

/**
 * The two halves of the pipeline run separately, so each has its own progress
 * scale — an index run must not stall the bar at the point where generation
 * would only be starting.
 */
const INDEX_STAGES: Record<string, Stage> = {
  resolving: { label: 'Finding the paper', percent: 20 },
  fetching:  { label: 'Downloading PDF', percent: 55 },
  indexing:  { label: 'Building embeddings', percent: 85 },
};

const ARTIFACT_STAGES: Record<string, Stage> = {
  resolving: { label: 'Finding the paper', percent: 12 },
  fetching:  { label: 'Downloading PDF', percent: 25 },
  writing:   { label: 'Writing blog & slides', percent: 60 },
  media:     { label: 'Generating audio & art', percent: 85 },
  indexing:  { label: 'Refreshing the index', percent: 95 },
};

/** How each kind of source announces itself on the card. */
const KINDS = {
  paper:     { icon: FileText,  label: 'Paper',     tone: 'bg-panel-2 text-muted border-line' },
  web:       { icon: Globe,     label: 'Web',       tone: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-200' },
  wikipedia: { icon: Library,   label: 'Wikipedia', tone: 'bg-stone-100 dark:bg-stone-500/20 text-stone-700 dark:text-stone-300 border-stone-300' },
  youtube:   { icon: Youtube,   label: 'YouTube',   tone: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300 border-red-200' },
  video:     { icon: Video,     label: 'Video',     tone: 'bg-fuchsia-50 dark:bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-200' },
  audio:     { icon: Mic,       label: 'Audio',     tone: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-200' },
  document:  { icon: FileType,  label: 'Document',  tone: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-200' },
} as const;

const kindOf = (paper: Paper) => KINDS[paper.kind ?? 'paper'] ?? KINDS.paper;

const isIndexing = (paper: Paper) => paper.indexStatus === 'indexing';
const isGenerating = (paper: Paper) =>
  paper.status === 'downloading' || paper.status === 'processing';

const stageOf = (paper: Paper): Stage => {
  const stages = isGenerating(paper) ? ARTIFACT_STAGES : INDEX_STAGES;
  return stages[paper.stage ?? ''] ?? { label: 'Working', percent: 40 };
};

const PaperList: React.FC<PaperListProps> = ({ 
    papers, 
    selectedIds, 
    onToggleSelect, 
    onSelectAll, 
    onIndex,
    onGenerate,
    busy,
    onReadBlog, 
    onFetchCitations 
}) => {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<string>('All Years');
  const [selectedAuthor, setSelectedAuthor] = useState<string>('All Authors');
  
  // Track which papers have their citations expanded
  const [expandedCitations, setExpandedCitations] = useState<Set<string>>(new Set());
  // Track loading state for citations
  const [loadingCitations, setLoadingCitations] = useState<Set<string>>(new Set());

  // Derived state for filters
  const uniqueYears = useMemo(() => {
    const years = new Set(papers.map(p => p.year).filter(y => y));
    return Array.from(years).sort().reverse();
  }, [papers]);

  const uniqueAuthors = useMemo(() => {
    const authors = new Set(papers.flatMap(p => p.authors).filter(a => a));
    return Array.from(authors).sort();
  }, [papers]);

  const filteredPapers = useMemo(() => {
    return papers.filter(paper => {
      const yearMatch = selectedYear === 'All Years' || paper.year === selectedYear;
      const authorMatch = selectedAuthor === 'All Authors' || paper.authors.includes(selectedAuthor);
      return yearMatch && authorMatch;
    });
  }, [papers, selectedYear, selectedAuthor]);

  const handlePlayAudio = async (e: React.MouseEvent, paper: Paper) => {
    e.stopPropagation();
    if (!paper.audioKey) return;
    
    // Toggle: Stop if currently playing this paper
    if (playingId === paper.id) {
        stopAudio();
        setPlayingId(null);
        return;
    }

    // Play new paper (implicitly stops others via utility)
    setPlayingId(paper.id);
    await playAudioUrl(blobUrl(paper.audioKey)!, () => {
        setPlayingId(prev => prev === paper.id ? null : prev);
    });
  };

  const toggleCitations = async (e: React.MouseEvent, paper: Paper) => {
    e.stopPropagation();
    
    // If expanding and no data, fetch it
    if (!expandedCitations.has(paper.id)) {
        if (!paper.citingPapers || paper.citingPapers.length === 0) {
            setLoadingCitations(prev => new Set(prev).add(paper.id));
            try {
                await onFetchCitations(paper);
            } finally {
                setLoadingCitations(prev => {
                    const next = new Set(prev);
                    next.delete(paper.id);
                    return next;
                });
            }
        }
    }

    setExpandedCitations(prev => {
        const next = new Set(prev);
        if (next.has(paper.id)) {
            next.delete(paper.id);
        } else {
            next.add(paper.id);
        }
        return next;
    });
  };

  const isAllSelected = papers.length > 0 && selectedIds.size === papers.length;
  const isSomeSelected = selectedIds.size > 0 && selectedIds.size < papers.length;

  if (papers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-subtle glass-panel rounded-2xl border border-line/50">
        <div className="bg-panel-2 p-4 rounded-full mb-4">
            <FileText className="w-8 h-8 opacity-40" />
        </div>
        <p className="font-medium text-muted">No papers found yet.</p>
        <p className="text-sm text-subtle mt-1">Start by searching for a scholar above.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20">
      
      {/* Control Bar */}
      <div className="glass-panel p-3 rounded-2xl border border-line/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4 sticky top-0 z-10 shadow-sm backdrop-blur-md">
         <div className="flex items-center gap-3">
             <button 
               onClick={onSelectAll}
               className="flex items-center gap-2 text-sm font-semibold text-ink hover:text-scholarly-700 transition-colors px-2"
             >
                {isAllSelected ? (
                    <CheckSquare className="w-5 h-5 text-scholarly-600" />
                ) : isSomeSelected ? (
                    <div className="relative w-5 h-5 flex items-center justify-center">
                        <SquareIcon className="w-5 h-5 text-subtle absolute" />
                        <div className="w-2.5 h-2.5 bg-scholarly-600 rounded-sm z-10"></div>
                    </div>
                ) : (
                    <SquareIcon className="w-5 h-5 text-subtle" />
                )}
                <span className="hidden sm:inline">Select All</span>
             </button>
             
             {selectedIds.size > 0 && (
                 <div className="h-5 w-px bg-line mx-1"></div>
             )}
             
             {selectedIds.size > 0 && (
                 <div className="flex items-center gap-2 animate-in fade-in zoom-in">
                     <button
                        onClick={onIndex}
                        disabled={busy}
                        title="Embed these papers into the search index so chat can cite them"
                        className="flex items-center gap-2 bg-panel text-ink border border-line px-4 py-2 rounded-xl text-sm font-semibold hover:bg-surface hover:border-line transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                        <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />
                        Index ({selectedIds.size})
                     </button>
                     <button
                        onClick={onGenerate}
                        disabled={busy}
                        title="Write the blog, slides, quiz, audio and illustration"
                        className="flex items-center gap-2 bg-scholarly-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-scholarly-700 transition-all shadow-md shadow-scholarly-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                        <Wand2 className="w-4 h-4" />
                        Generate ({selectedIds.size})
                     </button>
                 </div>
             )}
         </div>

         {/* Filters */}
         <div className="flex flex-wrap items-center gap-2 justify-end">
            <div className="relative group">
               <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle group-hover:text-scholarly-500 transition-colors pointer-events-none" />
               <select
                 value={selectedYear}
                 onChange={(e) => setSelectedYear(e.target.value)}
                 className="pl-9 pr-8 py-2 bg-panel/50 border border-line rounded-xl text-xs font-semibold text-muted focus:outline-none focus:ring-2 focus:ring-scholarly-200 cursor-pointer appearance-none hover:bg-panel transition-all shadow-sm"
               >
                 <option value="All Years">All Years</option>
                 {uniqueYears.map(year => (
                   <option key={year} value={year}>{year}</option>
                 ))}
               </select>
            </div>

            <div className="relative">
               <select
                 value={selectedAuthor}
                 onChange={(e) => setSelectedAuthor(e.target.value)}
                 className="pl-3 pr-8 py-2 bg-panel/50 border border-line rounded-xl text-xs font-semibold text-muted focus:outline-none focus:ring-2 focus:ring-scholarly-200 cursor-pointer appearance-none hover:bg-panel transition-all shadow-sm max-w-[140px] truncate"
               >
                 <option value="All Authors">All Authors</option>
                 {uniqueAuthors.map(author => (
                   <option key={author} value={author}>{author}</option>
                 ))}
               </select>
            </div>
        </div>
      </div>
      
      {filteredPapers.length === 0 ? (
         <div className="flex flex-col items-center justify-center py-12 glass-panel rounded-2xl border border-dashed border-line">
            <Filter className="w-8 h-8 text-subtle mb-2" />
            <p className="text-muted text-sm font-medium">No papers match your filters.</p>
            <button 
              onClick={() => { setSelectedYear('All Years'); setSelectedAuthor('All Authors'); }}
              className="mt-3 text-scholarly-600 text-sm font-bold hover:text-scholarly-700 hover:underline"
            >
              Clear All Filters
            </button>
         </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
        {filteredPapers.map((paper) => {
          const isSelected = selectedIds.has(paper.id);
          const generating = isGenerating(paper);
          const indexing = isIndexing(paper);
          const isProcessing = generating || indexing;
          // Papers indexed before indexStatus existed still carry a document name.
          const indexed = !indexing && (paper.indexStatus === 'indexed' || !!paper.fileSearchDocName);

          return (
          <div 
          key={paper.id} 
          className={`bg-panel/80 backdrop-blur-sm rounded-2xl border p-5 shadow-sm hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/40 hover:scale-[1.01] transition-all duration-300 relative overflow-hidden group ${isSelected ? 'border-scholarly-300 ring-2 ring-scholarly-100' : 'border-line/60'}`}
        >
          {/* Progress Bar Background */}
          {isProcessing && (
            <div className="absolute bottom-0 left-0 w-full h-1">
               <div 
                 className={`h-full transition-all duration-1000 ease-in-out ${
                   generating ? 'bg-purple-500' : 'bg-emerald-500'
                 }`}
                 style={{ width: `${stageOf(paper).percent}%` }}
               >
                 <div className="absolute inset-0 bg-panel/20 animate-pulse"></div>
               </div>
            </div>
          )}

          <div className="flex gap-5">
            {/* Selection Checkbox */}
            <div className="shrink-0 pt-1">
                <button 
                    onClick={() => onToggleSelect(paper.id)}
                    disabled={isProcessing}
                    className={`transition-transform active:scale-95 ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                    {isSelected ? (
                        <CheckSquare className="w-6 h-6 text-scholarly-600" />
                    ) : (
                        <SquareIcon className="w-6 h-6 text-subtle hover:text-scholarly-400 transition-colors" />
                    )}
                </button>
            </div>

            {/* Thumbnail Image or Placeholder */}
            {paper.status === 'converted' && paper.illustrationKey ? (
              <div 
                className="hidden sm:block w-32 h-24 shrink-0 rounded-xl bg-panel-2 overflow-hidden cursor-pointer hover:opacity-90 transition-opacity border border-line shadow-inner group-hover:shadow-md"
                onClick={() => onReadBlog(paper)}
              >
                <img 
                  src={blobUrl(paper.illustrationKey)}
                  loading="lazy" 
                  alt="Paper illustration" 
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                />
              </div>
            ) : isProcessing ? (
               <div className="hidden sm:flex w-32 h-24 shrink-0 rounded-xl bg-surface border border-line items-center justify-center flex-col gap-2">
                 {generating ? (
                    <Sparkles className="w-6 h-6 animate-pulse text-purple-500" />
                 ) : (
                    <Database className="w-6 h-6 animate-pulse text-emerald-500" />
                 )}
                 <span className="text-[10px] font-bold text-subtle uppercase tracking-wider">
                    {generating ? 'AI Magic' : 'Indexing'}
                 </span>
               </div>
            ) : null}

            <div className="flex-1 flex flex-col justify-between min-w-0">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {(() => {
                      const kind = kindOf(paper);
                      const KindIcon = kind.icon;
                      return (
                        <span className={`text-xs font-bold px-2.5 py-1 rounded-lg border flex items-center gap-1.5 ${kind.tone}`}>
                          <KindIcon className="w-3 h-3" />
                          {paper.year || kind.label}
                        </span>
                      );
                    })()}
                    
                    {(paper.kind ?? 'paper') === 'paper' && (
                    <button 
                       onClick={(e) => toggleCitations(e, paper)}
                       disabled={loadingCitations.has(paper.id)}
                       className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors border ${
                           expandedCitations.has(paper.id)
                           ? 'bg-scholarly-50 text-scholarly-700 border-scholarly-200' 
                           : 'bg-transparent text-muted border-transparent hover:bg-surface hover:border-line'
                       }`}
                    >
                        {loadingCitations.has(paper.id) ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                            <Quote className="w-3 h-3" />
                        )}
                        {paper.citationCount || 'View'} Citations
                        {expandedCitations.has(paper.id) ? (
                            <ChevronUp className="w-3 h-3 ml-0.5" />
                        ) : (
                            <ChevronDown className="w-3 h-3 ml-0.5" />
                        )}
                    </button>
                    )}
                    {paper.sourceUrl && (paper.kind ?? 'paper') !== 'paper' && (
                      <a
                        href={paper.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={e => e.stopPropagation()}
                        className="text-xs font-semibold text-muted hover:text-scholarly-700 hover:underline truncate max-w-[16rem]"
                      >
                        {(() => { try { return new URL(paper.sourceUrl).hostname.replace(/^www\./, ''); } catch { return 'source'; } })()}
                      </a>
                    )}
                  </div>
                  
                  {/* Status Icon Top Right */}
                   <div className="shrink-0">
                     {paper.status === 'converted' ? (
                       <div className="bg-green-100 dark:bg-green-500/20 p-1 rounded-full">
                         <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-300" />
                       </div>
                     ) : paper.status === 'error' ? (
                        <div className="bg-red-100 dark:bg-red-500/20 p-1 rounded-full">
                         <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-300" />
                       </div>
                     ) : indexing ? (
                       <div className="relative">
                         <div className="absolute inset-0 bg-emerald-200 rounded-full animate-ping opacity-75"></div>
                         <Database className="relative w-5 h-5 text-emerald-600 dark:text-emerald-300" />
                       </div>
                     ) : generating ? (
                       <div className="relative">
                         <div className="absolute inset-0 bg-purple-200 rounded-full animate-ping opacity-75"></div>
                         <Sparkles className="relative w-5 h-5 text-purple-600 dark:text-purple-300" />
                       </div>
                     ) : (
                       <div className="w-5 h-5 rounded-full border-2 border-line bg-surface"></div>
                     )}
                  </div>
                </div>
                
                <h3 className="text-lg font-bold text-ink leading-tight mb-1 truncate hover:text-scholarly-700 transition-colors cursor-pointer" onClick={() => onToggleSelect(paper.id)}>
                  {paper.title}
                </h3>
                
                <div className="mb-2.5 text-xs font-semibold text-muted uppercase tracking-wide line-clamp-1">
                  {paper.authors.length > 0 ? paper.authors.join(", ") : "Unknown Authors"}
                </div>

                <p className="text-sm text-muted line-clamp-2 mb-4 leading-relaxed">
                  {paper.summary}
                </p>

                {/* Expanded Citation List */}
                {expandedCitations.has(paper.id) && (
                    <div className="mt-4 mb-4 bg-surface/80 backdrop-blur-sm rounded-xl p-4 border border-line animate-in slide-in-from-top-2 fade-in shadow-inner">
                        <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-bold text-muted uppercase tracking-wider flex items-center gap-2">
                                <Quote className="w-3 h-3" /> Citing Papers
                            </h4>
                        </div>
                        {paper.citingPapers && paper.citingPapers.length > 0 ? (
                            <div className="space-y-3">
                                {paper.citingPapers.map((cite, idx) => (
                                    <div key={idx} className="bg-panel p-3 rounded-lg border border-line text-sm shadow-sm hover:shadow-md transition-shadow">
                                        <div className="font-semibold text-ink">{cite.title}</div>
                                        <div className="text-xs text-muted mt-1 flex gap-2">
                                            <span className="bg-panel-2 px-1.5 rounded text-muted font-medium">{cite.year}</span>
                                            <span>{cite.authors.join(", ")}</span>
                                        </div>
                                        <div className="text-xs text-muted mt-2 italic pl-2 border-l-2 border-scholarly-200">
                                            "{cite.summary}"
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-sm text-subtle italic text-center py-2">No significant citing papers found.</p>
                        )}
                    </div>
                )}
              </div>
              
              <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-line/50">
                {/* Indexing state is independent of generation, so it gets its own chip. */}
                {indexed && (
                   <span
                     className="text-xs flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-semibold px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-100"
                     title={
                       (paper.indexedKind === 'summary'
                         ? 'No open-access PDF, so the write-up was embedded instead'
                         : 'Full text embedded — chat can cite this paper') +
                       (paper.pdfReused
                         ? '\nThe PDF came from the shared corpus: another profile had already fetched it.'
                         : '')
                     }
                   >
                     <Database className="w-3 h-3" />
                     {paper.indexedKind === 'summary' ? 'Indexed (summary)' : 'Indexed'}
                   </span>
                )}
                {paper.indexStatus === 'error' && !indexed && !indexing && (
                   <span className="text-xs flex items-center gap-1.5 text-amber-700 dark:text-amber-300 font-semibold px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-500/15 border border-amber-100">
                     <AlertCircle className="w-3 h-3" /> Not indexed
                   </span>
                )}
                {paper.status === 'discovered' && !isProcessing && (
                   <span className="text-xs flex items-center gap-1.5 text-subtle font-medium px-2 py-1 rounded-full bg-surface border border-line">
                     <span className="w-1.5 h-1.5 rounded-full bg-subtle"></span> Ready to Analyze
                   </span>
                )}
                {isProcessing && (
                  <span className={`text-xs flex items-center gap-1.5 font-bold px-2 py-1 rounded-full ${
                    generating ? 'text-purple-600 dark:text-purple-300 bg-purple-50 dark:bg-purple-500/15' : 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15'
                  }`}>
                    <Loader2 className="w-3 h-3 animate-spin" /> {stageOf(paper).label}
                  </span>
                )}
                {paper.status === 'converted' && (
                  <>
                    <button 
                      onClick={() => onReadBlog(paper)}
                      className="flex items-center gap-1.5 text-xs font-bold text-white bg-scholarly-600 hover:bg-scholarly-700 px-4 py-2 rounded-xl transition-all shadow-md shadow-scholarly-200 hover:scale-105 active:scale-95"
                    >
                      <BookOpen className="w-3.5 h-3.5" /> Read
                    </button>
                    
                    <button 
                       onClick={() => onReadBlog(paper)} 
                       className="flex items-center gap-1.5 text-xs font-semibold text-ink bg-panel border border-line hover:bg-surface hover:border-line px-4 py-2 rounded-xl transition-all"
                    >
                      <MonitorPlay className="w-3.5 h-3.5" /> Slides
                    </button>

                    {paper.audioKey && (
                      <button 
                        onClick={(e) => handlePlayAudio(e, paper)}
                        className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl transition-all border ${
                          playingId === paper.id 
                            ? 'text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/15 border-red-100 hover:bg-red-100 dark:bg-red-500/20' 
                            : 'text-ink bg-panel border-line hover:bg-surface'
                        }`}
                      >
                         {playingId === paper.id ? (
                           <>
                             <Square className="w-3.5 h-3.5 fill-current" /> Stop
                           </>
                         ) : (
                           <>
                             <Play className="w-3.5 h-3.5" /> Audio
                           </>
                         )}
                      </button>
                    )}
                  </>
                )}
                {paper.status === 'error' && (
                   <span className="text-xs flex items-center gap-1 text-red-500 dark:text-red-300 font-medium">
                     <AlertCircle className="w-3 h-3" /> Failed
                   </span>
                )}
              </div>
            </div>
          </div>
        </div>
        );
      })
      }
      </div>
      )}
    </div>
  );
};

export default PaperList;