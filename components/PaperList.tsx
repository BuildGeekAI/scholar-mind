import React, { useState, useMemo } from 'react';
import { Paper } from '../types';
import { FileText, Loader2, CheckCircle, AlertCircle, BookOpen, MonitorPlay, Play, Filter, X, Sparkles, Square, Quote, ChevronDown, ChevronUp, CheckSquare, Square as SquareIcon, Wand2, Database } from 'lucide-react';
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
      <div className="flex flex-col items-center justify-center h-64 text-slate-400 glass-panel rounded-2xl border border-white/50">
        <div className="bg-slate-100 p-4 rounded-full mb-4">
            <FileText className="w-8 h-8 opacity-40" />
        </div>
        <p className="font-medium text-slate-500">No papers found yet.</p>
        <p className="text-sm text-slate-400 mt-1">Start by searching for a scholar above.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20">
      
      {/* Control Bar */}
      <div className="glass-panel p-3 rounded-2xl border border-white/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4 sticky top-0 z-10 shadow-sm backdrop-blur-md">
         <div className="flex items-center gap-3">
             <button 
               onClick={onSelectAll}
               className="flex items-center gap-2 text-sm font-semibold text-slate-700 hover:text-scholarly-700 transition-colors px-2"
             >
                {isAllSelected ? (
                    <CheckSquare className="w-5 h-5 text-scholarly-600" />
                ) : isSomeSelected ? (
                    <div className="relative w-5 h-5 flex items-center justify-center">
                        <SquareIcon className="w-5 h-5 text-slate-400 absolute" />
                        <div className="w-2.5 h-2.5 bg-scholarly-600 rounded-sm z-10"></div>
                    </div>
                ) : (
                    <SquareIcon className="w-5 h-5 text-slate-400" />
                )}
                <span className="hidden sm:inline">Select All</span>
             </button>
             
             {selectedIds.size > 0 && (
                 <div className="h-5 w-px bg-slate-200 mx-1"></div>
             )}
             
             {selectedIds.size > 0 && (
                 <div className="flex items-center gap-2 animate-in fade-in zoom-in">
                     <button
                        onClick={onIndex}
                        disabled={busy}
                        title="Embed these papers into the search index so chat can cite them"
                        className="flex items-center gap-2 bg-white text-slate-700 border border-slate-200 px-4 py-2 rounded-xl text-sm font-semibold hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                        <Database className="w-4 h-4 text-emerald-600" />
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
               <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-hover:text-scholarly-500 transition-colors pointer-events-none" />
               <select
                 value={selectedYear}
                 onChange={(e) => setSelectedYear(e.target.value)}
                 className="pl-9 pr-8 py-2 bg-white/50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 focus:outline-none focus:ring-2 focus:ring-scholarly-200 cursor-pointer appearance-none hover:bg-white transition-all shadow-sm"
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
                 className="pl-3 pr-8 py-2 bg-white/50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 focus:outline-none focus:ring-2 focus:ring-scholarly-200 cursor-pointer appearance-none hover:bg-white transition-all shadow-sm max-w-[140px] truncate"
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
         <div className="flex flex-col items-center justify-center py-12 glass-panel rounded-2xl border border-dashed border-slate-300">
            <Filter className="w-8 h-8 text-slate-300 mb-2" />
            <p className="text-slate-500 text-sm font-medium">No papers match your filters.</p>
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
          className={`bg-white/80 backdrop-blur-sm rounded-2xl border p-5 shadow-sm hover:shadow-xl hover:shadow-slate-200/50 hover:scale-[1.01] transition-all duration-300 relative overflow-hidden group ${isSelected ? 'border-scholarly-300 ring-2 ring-scholarly-100' : 'border-white/60'}`}
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
                 <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
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
                        <SquareIcon className="w-6 h-6 text-slate-300 hover:text-scholarly-400 transition-colors" />
                    )}
                </button>
            </div>

            {/* Thumbnail Image or Placeholder */}
            {paper.status === 'converted' && paper.illustrationKey ? (
              <div 
                className="hidden sm:block w-32 h-24 shrink-0 rounded-xl bg-slate-100 overflow-hidden cursor-pointer hover:opacity-90 transition-opacity border border-slate-100 shadow-inner group-hover:shadow-md"
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
               <div className="hidden sm:flex w-32 h-24 shrink-0 rounded-xl bg-slate-50 border border-slate-100 items-center justify-center flex-col gap-2">
                 {generating ? (
                    <Sparkles className="w-6 h-6 animate-pulse text-purple-500" />
                 ) : (
                    <Database className="w-6 h-6 animate-pulse text-emerald-500" />
                 )}
                 <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    {generating ? 'AI Magic' : 'Indexing'}
                 </span>
               </div>
            ) : null}

            <div className="flex-1 flex flex-col justify-between min-w-0">
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 border border-slate-200">
                      {paper.year}
                    </span>
                    
                    <button 
                       onClick={(e) => toggleCitations(e, paper)}
                       disabled={loadingCitations.has(paper.id)}
                       className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors border ${
                           expandedCitations.has(paper.id)
                           ? 'bg-scholarly-50 text-scholarly-700 border-scholarly-200' 
                           : 'bg-transparent text-slate-500 border-transparent hover:bg-slate-50 hover:border-slate-200'
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
                  </div>
                  
                  {/* Status Icon Top Right */}
                   <div className="shrink-0">
                     {paper.status === 'converted' ? (
                       <div className="bg-green-100 p-1 rounded-full">
                         <CheckCircle className="w-4 h-4 text-green-600" />
                       </div>
                     ) : paper.status === 'error' ? (
                        <div className="bg-red-100 p-1 rounded-full">
                         <AlertCircle className="w-4 h-4 text-red-500" />
                       </div>
                     ) : indexing ? (
                       <div className="relative">
                         <div className="absolute inset-0 bg-emerald-200 rounded-full animate-ping opacity-75"></div>
                         <Database className="relative w-5 h-5 text-emerald-600" />
                       </div>
                     ) : generating ? (
                       <div className="relative">
                         <div className="absolute inset-0 bg-purple-200 rounded-full animate-ping opacity-75"></div>
                         <Sparkles className="relative w-5 h-5 text-purple-600" />
                       </div>
                     ) : (
                       <div className="w-5 h-5 rounded-full border-2 border-slate-200 bg-slate-50"></div>
                     )}
                  </div>
                </div>
                
                <h3 className="text-lg font-bold text-slate-900 leading-tight mb-1 truncate hover:text-scholarly-700 transition-colors cursor-pointer" onClick={() => onToggleSelect(paper.id)}>
                  {paper.title}
                </h3>
                
                <div className="mb-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide line-clamp-1">
                  {paper.authors.length > 0 ? paper.authors.join(", ") : "Unknown Authors"}
                </div>

                <p className="text-sm text-slate-600 line-clamp-2 mb-4 leading-relaxed">
                  {paper.summary}
                </p>

                {/* Expanded Citation List */}
                {expandedCitations.has(paper.id) && (
                    <div className="mt-4 mb-4 bg-slate-50/80 backdrop-blur-sm rounded-xl p-4 border border-slate-200 animate-in slide-in-from-top-2 fade-in shadow-inner">
                        <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                                <Quote className="w-3 h-3" /> Citing Papers
                            </h4>
                        </div>
                        {paper.citingPapers && paper.citingPapers.length > 0 ? (
                            <div className="space-y-3">
                                {paper.citingPapers.map((cite, idx) => (
                                    <div key={idx} className="bg-white p-3 rounded-lg border border-slate-100 text-sm shadow-sm hover:shadow-md transition-shadow">
                                        <div className="font-semibold text-slate-800">{cite.title}</div>
                                        <div className="text-xs text-slate-500 mt-1 flex gap-2">
                                            <span className="bg-slate-100 px-1.5 rounded text-slate-600 font-medium">{cite.year}</span>
                                            <span>{cite.authors.join(", ")}</span>
                                        </div>
                                        <div className="text-xs text-slate-600 mt-2 italic pl-2 border-l-2 border-scholarly-200">
                                            "{cite.summary}"
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-sm text-slate-400 italic text-center py-2">No significant citing papers found.</p>
                        )}
                    </div>
                )}
              </div>
              
              <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100/50">
                {/* Indexing state is independent of generation, so it gets its own chip. */}
                {indexed && (
                   <span
                     className="text-xs flex items-center gap-1.5 text-emerald-700 font-semibold px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-100"
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
                   <span className="text-xs flex items-center gap-1.5 text-amber-700 font-semibold px-2.5 py-1 rounded-full bg-amber-50 border border-amber-100">
                     <AlertCircle className="w-3 h-3" /> Not indexed
                   </span>
                )}
                {paper.status === 'discovered' && !isProcessing && (
                   <span className="text-xs flex items-center gap-1.5 text-slate-400 font-medium px-2 py-1 rounded-full bg-slate-50 border border-slate-100">
                     <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span> Ready to Analyze
                   </span>
                )}
                {isProcessing && (
                  <span className={`text-xs flex items-center gap-1.5 font-bold px-2 py-1 rounded-full ${
                    generating ? 'text-purple-600 bg-purple-50' : 'text-emerald-700 bg-emerald-50'
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
                       className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 px-4 py-2 rounded-xl transition-all"
                    >
                      <MonitorPlay className="w-3.5 h-3.5" /> Slides
                    </button>

                    {paper.audioKey && (
                      <button 
                        onClick={(e) => handlePlayAudio(e, paper)}
                        className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl transition-all border ${
                          playingId === paper.id 
                            ? 'text-red-600 bg-red-50 border-red-100 hover:bg-red-100' 
                            : 'text-slate-700 bg-white border-slate-200 hover:bg-slate-50'
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
                   <span className="text-xs flex items-center gap-1 text-red-500 font-medium">
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