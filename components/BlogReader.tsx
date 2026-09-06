import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Paper } from '../types';
import { X, FileText, MonitorPlay, Play, Loader2, BrainCircuit, Layers, Check, ChevronLeft, ChevronRight, RotateCw, Calendar, Quote, Clock, Copy, Download, Square, Mic, Volume2, Radio } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { playAudioUrl, playAudioBlob, stopAudio } from '../utils/audio';
import { blobUrl, speak } from '../services/api';

interface BlogReaderProps {
  paper: Paper | null;
  onClose: () => void;
}

const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];

const BlogReader: React.FC<BlogReaderProps> = ({ paper, onClose }) => {
  const [activeTab, setActiveTab] = useState<'blog' | 'slides' | 'quiz' | 'flashcards'>('blog');
  const [isPlaying, setIsPlaying] = useState(false);
  const [showCitationModal, setShowCitationModal] = useState(false);
  
  // Quiz State
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [score, setScore] = useState(0);

  // Conversational Quiz State
  const [isConversationalMode, setIsConversationalMode] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('Kore');
  const [hostStatus, setHostStatus] = useState<'idle' | 'speaking' | 'listening'>('idle');

  // Flashcard State
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  // Refs
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup audio on unmount or close
  useEffect(() => {
    return () => {
      stopAudio();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Memoized Markdown Components for performance
  const markdownComponents = useMemo(() => ({
    h1: ({node, ...props}: any) => <h2 className="text-2xl font-sans font-bold mt-8 mb-4 text-ink leading-tight" {...props} />,
    h2: ({node, ...props}: any) => <h3 className="text-xl font-sans font-bold mt-8 mb-4 text-ink leading-tight" {...props} />,
    h3: ({node, ...props}: any) => <h4 className="text-lg font-sans font-bold mt-6 mb-2 text-ink leading-tight" {...props} />,
    p: ({node, ...props}: any) => <p className="mb-6 leading-relaxed text-ink" {...props} />,
    ul: ({node, ...props}: any) => <ul className="list-disc list-outside ml-6 mb-6 space-y-2 text-ink marker:text-scholarly-400" {...props} />,
    ol: ({node, ...props}: any) => <ol className="list-decimal list-outside ml-6 mb-6 space-y-2 text-ink marker:text-scholarly-400 font-medium" {...props} />,
    blockquote: ({node, ...props}: any) => (
      <blockquote className="border-l-4 border-scholarly-500 pl-6 py-4 my-8 italic text-ink bg-scholarly-50/30 rounded-r-xl shadow-sm" {...props} />
    ),
    pre: ({node, ...props}: any) => (
      <pre className="bg-slate-900 text-slate-100 p-5 rounded-xl overflow-x-auto my-8 text-sm font-mono shadow-lg border border-slate-800 custom-scrollbar" {...props} />
    ),
    code: ({node, inline, className, children, ...props}: any) => {
      if (inline) {
        return (
          <code className="font-mono text-[0.9em] bg-panel-2 text-pink-600 px-1.5 py-0.5 rounded border border-line" {...props}>
            {children}
          </code>
        );
      }
      return (
        <code className="bg-transparent text-inherit p-0 border-0 font-mono" {...props} />
      );
    },
    a: ({node, ...props}: any) => (
        <a className="text-scholarly-600 hover:text-scholarly-800 underline underline-offset-2 transition-colors font-medium" {...props} />
    ),
    img: ({node, ...props}: any) => (
        <img className="rounded-xl shadow-md my-8 w-full object-cover max-h-[500px] border border-line" {...props} />
    ),
    hr: ({node, ...props}: any) => <hr className="my-8 border-line" {...props} />,
    table: ({node, ...props}: any) => (
        <div className="overflow-x-auto my-8 rounded-xl border border-line shadow-sm">
            <table className="w-full text-left text-sm text-muted" {...props} />
        </div>
    ),
    thead: ({node, ...props}: any) => <thead className="bg-surface text-ink font-semibold border-b border-line" {...props} />,
    th: ({node, ...props}: any) => <th className="px-6 py-3 whitespace-nowrap" {...props} />,
    td: ({node, ...props}: any) => <td className="px-6 py-4 border-b border-line last:border-0" {...props} />,
  }), []);

  if (!paper) return null;

  const handlePlayAudio = async () => {
    if (!paper.audioKey) return;
    
    // Toggle logic
    if (isPlaying) {
        stopAudio();
        setIsPlaying(false);
        return;
    }

    setIsPlaying(true);
    await playAudioUrl(blobUrl(paper.audioKey)!, () => {
        setIsPlaying(false);
    });
  };

  /* --- CONVERSATIONAL HOST LOGIC --- */
  
  const speakText = async (text: string, onEnded?: () => void) => {
    setHostStatus('speaking');
    stopAudio(); // Stop any previous audio
    
    const audioData = await speak(text, selectedVoice);
    if (audioData) {
        await playAudioBlob(audioData, () => {
            setHostStatus('idle');
            if (onEnded) onEnded();
        });
    } else {
        setHostStatus('idle');
        if (onEnded) onEnded();
    }
  };

  const startConversationalQuiz = async () => {
    setIsConversationalMode(true);
    setCurrentQuestionIndex(0);
    setScore(0);
    setIsAnswered(false);
    setSelectedAnswer(null);

    // Intro
    const introText = `Hi, I'm ${selectedVoice}. Let's see how well you understand "${paper.title}". I have ${paper.quiz?.length || 5} questions for you. Let's begin.`;
    
    await speakText(introText, () => {
        readQuestion(0);
    });
  };

  const readQuestion = (index: number) => {
    if (!paper.quiz) return;
    const q = paper.quiz[index];
    const text = `Question ${index + 1}. ${q.question}. Option 1: ${q.options[0]}. Option 2: ${q.options[1]}. Option 3: ${q.options[2]}. Option 4: ${q.options[3]}.`;
    
    setHostStatus('speaking');
    speakText(text, () => {
       setHostStatus('listening');
    });
  };

  const handleQuizOptionSelect = async (index: number) => {
    if (isAnswered) return;
    
    // UI Updates
    setSelectedAnswer(index);
    setIsAnswered(true);
    const isCorrect = index === paper.quiz?.[currentQuestionIndex].correctAnswer;
    if (isCorrect) {
      setScore(s => s + 1);
    }

    // Conversational Feedback
    if (isConversationalMode && paper.quiz) {
       setHostStatus('speaking');
       const q = paper.quiz[currentQuestionIndex];
       
       let feedbackText = "";
       if (isCorrect) {
           feedbackText = `That is correct! ${q.explanation}`;
       } else {
           feedbackText = `Not quite. The correct answer was Option ${q.correctAnswer + 1}. ${q.explanation}`;
       }
       
       // Play feedback then advance
       await speakText(feedbackText, () => {
           // Auto advance after small delay
           setTimeout(() => {
               if (currentQuestionIndex < (paper.quiz?.length || 0) - 1) {
                   nextQuestion();
               } else {
                   speakText(`Quiz complete! You got ${score + (isCorrect ? 1 : 0)} out of ${paper.quiz?.length}. Great effort!`);
               }
           }, 1000);
       });
    }
  };

  const nextQuestion = () => {
    stopAudio();
    if (paper.quiz && currentQuestionIndex < paper.quiz.length - 1) {
      const nextIdx = currentQuestionIndex + 1;
      setCurrentQuestionIndex(nextIdx);
      setSelectedAnswer(null);
      setIsAnswered(false);
      
      if (isConversationalMode) {
          readQuestion(nextIdx);
      }
    }
  };

  /* --- FLASHCARDS LOGIC --- */
  const nextCard = () => {
    setIsFlipped(false);
    setTimeout(() => {
        if (paper.flashCards && currentCardIndex < paper.flashCards.length - 1) {
            setCurrentCardIndex(prev => prev + 1);
        } else {
            setCurrentCardIndex(0);
        }
    }, 150);
  };

  const prevCard = () => {
    setIsFlipped(false);
    setTimeout(() => {
        if (currentCardIndex > 0) {
            setCurrentCardIndex(prev => prev - 1);
        } else if (paper.flashCards) {
            setCurrentCardIndex(paper.flashCards.length - 1);
        }
    }, 150);
  };

  /* --- UTILS --- */
  const getBibTeX = () => {
    if (!paper) return '';
    const authorStr = paper.authors.join(' and ');
    const titleStr = paper.title;
    const yearStr = paper.year;
    // Simple key generation
    const firstAuthor = paper.authors[0]?.split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, '') || 'author';
    const firstWord = titleStr.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'title';
    const key = `${firstAuthor}${yearStr}${firstWord}`;
    
    return `@article{${key},
  title={${titleStr}},
  author={${authorStr}},
  journal={arXiv preprint},
  year={${yearStr}}
}`;
  };

  const handleCopyCitation = () => {
    navigator.clipboard.writeText(getBibTeX());
    setShowCitationModal(false);
  };

  const handleDownloadSummary = () => {
    if (!paper) return;
    
    let content = `Title: ${paper.title}\n`;
    content += `Authors: ${paper.authors.join(', ')}\n`;
    content += `Year: ${paper.year}\n\n`;
    content += `SUMMARY:\n${paper.summary}\n\n`;
    
    if (paper.slides && paper.slides.length > 0) {
        content += `KEY TAKEAWAYS:\n`;
        paper.slides.forEach((slide, idx) => {
            content += `${idx + 1}. ${slide.title}\n`;
            slide.points.forEach(point => {
                content += `   - ${point}\n`;
            });
            content += '\n';
        });
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${paper.title.substring(0, 40).replace(/[^a-z0-9]/gi, '_')}_summary.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div 
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" 
        onClick={onClose}
      />
      
      <div className="relative bg-panel w-full max-w-4xl h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex flex-col border-b border-line bg-panel z-10 shrink-0">
          <div className="flex items-center justify-between px-6 py-4">
             <div>
                <h3 className="text-sm font-bold text-subtle uppercase tracking-wider">Research Viewer</h3>
             </div>
             <div className="flex items-center gap-2">
               {paper.audioKey && !isConversationalMode && (
                 <button 
                  onClick={handlePlayAudio}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-full transition-colors mr-2 ${
                    isPlaying 
                        ? 'text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-500/20 hover:bg-red-200' 
                        : 'text-scholarly-700 bg-scholarly-50 hover:bg-scholarly-100'
                  }`}
                 >
                   {isPlaying ? (
                        <>
                            <Square className="w-3.5 h-3.5 fill-current" /> Stop
                        </>
                   ) : (
                        <>
                            <Play className="w-4 h-4" /> Listen
                        </>
                   )}
                 </button>
               )}
               <button 
                 onClick={onClose}
                 className="p-2 text-subtle hover:text-red-500 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15 rounded-full transition-colors ml-2"
               >
                 <X className="w-6 h-6" />
               </button>
             </div>
          </div>
          
          {/* Tabs */}
          <div className="flex px-6 gap-6 overflow-x-auto scrollbar-hide">
            <button 
              onClick={() => { setActiveTab('blog'); setIsConversationalMode(false); stopAudio(); }}
              className={`pb-3 text-sm font-semibold flex items-center gap-2 transition-all border-b-2 whitespace-nowrap ${activeTab === 'blog' ? 'border-scholarly-600 text-scholarly-600' : 'border-transparent text-muted hover:text-ink'}`}
            >
              <FileText className="w-4 h-4" /> Article
            </button>
            <button 
              onClick={() => { setActiveTab('slides'); setIsConversationalMode(false); stopAudio(); }}
              className={`pb-3 text-sm font-semibold flex items-center gap-2 transition-all border-b-2 whitespace-nowrap ${activeTab === 'slides' ? 'border-scholarly-600 text-scholarly-600' : 'border-transparent text-muted hover:text-ink'}`}
            >
              <MonitorPlay className="w-4 h-4" /> Slides
            </button>
            <button 
              onClick={() => setActiveTab('quiz')}
              className={`pb-3 text-sm font-semibold flex items-center gap-2 transition-all border-b-2 whitespace-nowrap ${activeTab === 'quiz' ? 'border-scholarly-600 text-scholarly-600' : 'border-transparent text-muted hover:text-ink'}`}
            >
              <BrainCircuit className="w-4 h-4" /> Quiz ({paper.quiz?.length || 0})
            </button>
             <button 
              onClick={() => { setActiveTab('flashcards'); setIsConversationalMode(false); stopAudio(); }}
              className={`pb-3 text-sm font-semibold flex items-center gap-2 transition-all border-b-2 whitespace-nowrap ${activeTab === 'flashcards' ? 'border-scholarly-600 text-scholarly-600' : 'border-transparent text-muted hover:text-ink'}`}
            >
              <Layers className="w-4 h-4" /> Flashcards ({paper.flashCards?.length || 0})
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto bg-surface/50">
          
          {/* BLOG TAB */}
          {activeTab === 'blog' && (
            <div className="p-0">
               {/* Hero Illustration */}
               {paper.illustrationKey && (
                 <div className="w-full h-64 sm:h-80 bg-line overflow-hidden relative">
                    <img 
                      src={blobUrl(paper.illustrationKey)} 
                      alt="Scientific Illustration" 
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 to-transparent"></div>
                    <div className="absolute bottom-6 left-8 right-8 text-white">
                       <span className="text-xs font-bold uppercase tracking-widest bg-panel/20 backdrop-blur-md px-2 py-1 rounded-md mb-2 inline-block">Research Insight</span>
                       <h1 className="font-serif text-2xl sm:text-4xl font-bold leading-tight shadow-sm text-shadow">
                          {paper.blogTitle || paper.title}
                       </h1>
                    </div>
                 </div>
               )}

              <div className="p-8 sm:p-12 prose prose-slate max-w-none">
                {!paper.illustrationKey && paper.blogTitle && (
                  <h1 className="font-serif text-3xl sm:text-4xl text-ink mb-6 font-bold leading-tight">
                    {paper.blogTitle}
                  </h1>
                )}
                
                <div className="bg-panel border border-line p-5 rounded-lg shadow-sm mb-6 flex justify-between items-start gap-4">
                  <div className="flex-1">
                    <span className="font-semibold block text-ink mb-1 text-base">Original Paper</span> 
                    <p className="text-sm text-muted m-0 leading-relaxed">
                        {paper.title} ({paper.year})
                    </p>
                    <span className="text-muted text-xs mt-1 block font-medium">By {paper.authors.join(", ")}</span>
                  </div>
                  <div className="flex gap-2">
                    <button 
                      onClick={handleDownloadSummary}
                      className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-ink bg-surface hover:bg-panel-2 border border-line rounded-lg transition-all shrink-0"
                      title="Download Summary"
                    >
                      <Download className="w-4 h-4" /> Save
                    </button>
                    <button 
                      onClick={() => setShowCitationModal(true)}
                      className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-scholarly-700 bg-scholarly-50 hover:bg-scholarly-100 border border-scholarly-200 rounded-lg transition-all shrink-0"
                      title="Export Citation"
                    >
                      <Quote className="w-4 h-4" /> Cite
                    </button>
                  </div>
                </div>

                {/* Statistics Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                  <div className="flex items-center gap-3 p-4 bg-blue-50/50 rounded-xl border border-blue-100 hover:border-blue-200 transition-colors">
                     <div className="p-2.5 bg-blue-100 text-blue-600 rounded-lg shrink-0">
                       <Calendar className="w-5 h-5" />
                     </div>
                     <div>
                       <p className="text-xs font-bold text-muted uppercase tracking-wide">Published</p>
                       <p className="text-base font-bold text-ink">{paper.year}</p>
                     </div>
                  </div>
                  
                  <div className="flex items-center gap-3 p-4 bg-purple-50 dark:bg-purple-500/15/50 rounded-xl border border-purple-100 hover:border-purple-200 transition-colors">
                     <div className="p-2.5 bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-300 rounded-lg shrink-0">
                       <Quote className="w-5 h-5" />
                     </div>
                     <div>
                       <p className="text-xs font-bold text-muted uppercase tracking-wide">Citations</p>
                       <p className="text-base font-bold text-ink">{paper.citationCount || 'N/A'}</p>
                     </div>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-amber-50 dark:bg-amber-500/15/50 rounded-xl border border-amber-100 hover:border-amber-200 transition-colors">
                     <div className="p-2.5 bg-amber-100 text-amber-600 rounded-lg shrink-0">
                       <Clock className="w-5 h-5" />
                     </div>
                     <div>
                       <p className="text-xs font-bold text-muted uppercase tracking-wide">Read Time</p>
                       <p className="text-base font-bold text-ink">~{Math.ceil((paper.blogContent?.split(/\s+/).length || 0) / 200)} min</p>
                     </div>
                  </div>
                </div>

                <div className="font-serif text-lg leading-relaxed text-ink">
                  <ReactMarkdown components={markdownComponents}>
                    {paper.blogContent || ""}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}

          {/* SLIDES TAB */}
          {activeTab === 'slides' && (
             <div className="p-8 sm:p-12 space-y-8 max-w-4xl mx-auto">
               <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold text-ink">{paper.title}</h2>
                  <p className="text-muted">{paper.authors.join(", ")} • {paper.year}</p>
               </div>
               
               {paper.slides && paper.slides.length > 0 ? (
                 paper.slides.map((slide, idx) => (
                   <div key={idx} className="bg-panel p-8 rounded-2xl shadow-sm border border-line aspect-[16/9] flex flex-col">
                      <div className="flex items-center justify-between mb-6 border-b border-line pb-4">
                        <h3 className="text-xl font-bold text-scholarly-700">{slide.title}</h3>
                        <span className="text-subtle font-mono text-xl">{String(idx + 1).padStart(2, '0')}</span>
                      </div>
                      <div className="flex-1 flex flex-col justify-center">
                        <ul className="space-y-4">
                          {slide.points.map((point, pIdx) => (
                            <li key={pIdx} className="flex items-start gap-3 text-lg text-ink">
                              <span className="w-2 h-2 rounded-full bg-scholarly-400 mt-2.5 shrink-0"></span>
                              {point}
                            </li>
                          ))}
                        </ul>
                      </div>
                   </div>
                 ))
               ) : (
                 <div className="flex items-center justify-center h-64 text-subtle">
                   <p>No slides generated for this paper.</p>
                 </div>
               )}
             </div>
          )}

          {/* QUIZ TAB */}
          {activeTab === 'quiz' && paper.quiz && paper.quiz.length > 0 && (
             <div className="p-8 sm:p-12 flex flex-col items-center justify-center min-h-[500px]">
                
                {/* Conversational Mode Toggle & Voice Selection */}
                <div className="mb-8 flex flex-wrap items-center justify-center gap-4 bg-panel p-3 rounded-2xl shadow-sm border border-line">
                    <button
                        onClick={() => {
                            if (!isConversationalMode) {
                                startConversationalQuiz();
                            } else {
                                setIsConversationalMode(false);
                                stopAudio();
                                setHostStatus('idle');
                            }
                        }}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                            isConversationalMode 
                                ? 'bg-purple-600 text-white shadow-md shadow-purple-200 ring-2 ring-purple-100' 
                                : 'bg-panel-2 text-muted hover:bg-line'
                        }`}
                    >
                        {isConversationalMode ? <Volume2 className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                        {isConversationalMode ? 'Conversational Mode ON' : 'Start Conversational Quiz'}
                    </button>
                    
                    <div className="h-6 w-px bg-line hidden sm:block"></div>

                    <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-subtle uppercase tracking-wide">Host Voice:</span>
                        <select 
                            value={selectedVoice}
                            onChange={(e) => {
                                setSelectedVoice(e.target.value);
                                if (isConversationalMode) {
                                    // If changed during quiz, stop current audio. 
                                    // Could trigger a quick "Voice changed" sample, but keeping it simple.
                                    stopAudio();
                                    setHostStatus('idle');
                                }
                            }}
                            className="bg-surface border border-line text-ink text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2 outline-none cursor-pointer hover:bg-panel transition-colors"
                        >
                            {VOICES.map(v => (
                                <option key={v} value={v}>{v}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <div className={`w-full max-w-2xl bg-panel rounded-2xl shadow-lg border border-line overflow-hidden transition-all duration-500 ${isConversationalMode ? 'ring-4 ring-purple-100' : ''}`}>
                    <div className={`p-6 text-white flex justify-between items-center transition-colors duration-500 ${isConversationalMode ? 'bg-purple-900' : 'bg-slate-900'}`}>
                       <div className="flex items-center gap-3">
                           {isConversationalMode && (
                               <div className="relative">
                                   <div className={`w-3 h-3 rounded-full bg-green-400 ${hostStatus === 'speaking' ? 'animate-ping' : ''}`}></div>
                               </div>
                           )}
                           <h3 className="font-bold text-lg">{isConversationalMode ? 'Interactive Quiz' : 'Knowledge Check'}</h3>
                       </div>
                       <span className={`text-sm font-mono px-3 py-1 rounded-full ${isConversationalMode ? 'bg-purple-800' : 'bg-slate-800'}`}>
                         Question {currentQuestionIndex + 1}/{paper.quiz.length}
                       </span>
                    </div>
                    
                    {/* Visualizer for Conversational Mode */}
                    {isConversationalMode && hostStatus === 'speaking' && (
                        <div className="h-16 bg-purple-50 dark:bg-purple-500/15 w-full flex items-center justify-center gap-1 border-b border-purple-100">
                             {[...Array(5)].map((_, i) => (
                                 <div key={i} className="w-1 bg-purple-500 rounded-full animate-[bounce_1s_infinite]" style={{ height: '50%', animationDelay: `${i * 0.1}s` }}></div>
                             ))}
                             <span className="ml-3 text-xs font-bold text-purple-600 dark:text-purple-300 uppercase tracking-wider">{selectedVoice} is speaking...</span>
                        </div>
                    )}

                    <div className="p-8">
                       <h4 className="text-xl font-semibold text-ink mb-8 leading-relaxed">
                          {paper.quiz[currentQuestionIndex].question}
                       </h4>

                       <div className="space-y-3">
                         {paper.quiz[currentQuestionIndex].options.map((option, idx) => {
                            let optionClass = "w-full text-left p-4 rounded-xl border transition-all text-ink font-medium ";
                            
                            if (isAnswered) {
                               if (idx === paper.quiz![currentQuestionIndex].correctAnswer) {
                                  optionClass += "bg-green-100 dark:bg-green-500/20 border-green-500 text-green-800";
                               } else if (idx === selectedAnswer) {
                                  optionClass += "bg-red-100 dark:bg-red-500/20 border-red-500 text-red-800";
                               } else {
                                  optionClass += "bg-surface border-line opacity-60";
                               }
                            } else {
                               optionClass += "bg-panel border-line hover:border-scholarly-400 hover:bg-scholarly-50";
                            }

                            return (
                               <button 
                                 key={idx}
                                 onClick={() => handleQuizOptionSelect(idx)}
                                 disabled={isAnswered || (isConversationalMode && hostStatus === 'speaking')}
                                 className={optionClass}
                               >
                                  <div className="flex items-center justify-between">
                                     <span>{option}</span>
                                     {isAnswered && idx === paper.quiz![currentQuestionIndex].correctAnswer && (
                                        <Check className="w-5 h-5 text-green-600 dark:text-green-300" />
                                     )}
                                  </div>
                               </button>
                            );
                         })}
                       </div>

                       {isAnswered && (
                          <div className="mt-6 p-4 bg-blue-50 border border-blue-100 rounded-xl text-blue-900 text-sm animate-in fade-in slide-in-from-top-2">
                             <span className="font-bold block mb-1">Explanation:</span>
                             {paper.quiz[currentQuestionIndex].explanation}
                          </div>
                       )}
                    </div>
                    
                    <div className="p-6 border-t border-line bg-surface flex justify-between items-center">
                       <div className="text-sm font-medium text-muted">
                          Current Score: <span className="text-scholarly-600 font-bold">{score}</span>
                       </div>
                       <button 
                         onClick={nextQuestion}
                         disabled={!isAnswered || currentQuestionIndex === paper.quiz.length - 1 || (isConversationalMode && hostStatus === 'speaking')}
                         className="flex items-center gap-2 px-6 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                       >
                         {currentQuestionIndex === paper.quiz.length - 1 ? "Finish" : "Next Question"} <ChevronRight className="w-4 h-4" />
                       </button>
                    </div>
                </div>
             </div>
          )}

          {/* FLASHCARDS TAB */}
          {activeTab === 'flashcards' && paper.flashCards && paper.flashCards.length > 0 && (
             <div className="p-8 sm:p-12 flex flex-col items-center justify-center min-h-[500px]">
                <div className="w-full max-w-xl perspective-1000">
                   <div 
                      className={`relative w-full aspect-[3/2] cursor-pointer group transition-all duration-500 transform-style-3d ${isFlipped ? 'rotate-y-180' : ''}`}
                      onClick={() => setIsFlipped(!isFlipped)}
                      style={{ transformStyle: 'preserve-3d', transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)', transition: 'transform 0.6s' }}
                   >
                      {/* Front */}
                      <div 
                          className="absolute inset-0 w-full h-full bg-panel rounded-2xl shadow-xl border border-line p-8 flex flex-col items-center justify-center text-center backface-hidden"
                          style={{ backfaceVisibility: 'hidden' }}
                      >
                          <span className="text-xs font-bold text-subtle uppercase tracking-widest mb-4">Term</span>
                          <h3 className="text-3xl font-serif font-bold text-ink">
                              {paper.flashCards[currentCardIndex].front}
                          </h3>
                          <p className="absolute bottom-6 text-xs text-subtle flex items-center gap-1">
                             <RotateCw className="w-3 h-3" /> Click to flip
                          </p>
                      </div>

                      {/* Back */}
                      <div 
                          className="absolute inset-0 w-full h-full bg-slate-900 rounded-2xl shadow-xl p-8 flex flex-col items-center justify-center text-center backface-hidden"
                          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
                      >
                          <span className="text-xs font-bold text-subtle uppercase tracking-widest mb-4">Definition</span>
                          <p className="text-xl text-white font-medium leading-relaxed">
                              {paper.flashCards[currentCardIndex].back}
                          </p>
                      </div>
                   </div>

                   {/* Controls */}
                   <div className="flex justify-between items-center mt-8">
                      <button 
                        onClick={prevCard}
                        className="p-3 rounded-full bg-panel border border-line text-muted hover:bg-surface hover:text-scholarly-600 transition-colors shadow-sm"
                      >
                         <ChevronLeft className="w-6 h-6" />
                      </button>
                      <span className="text-muted font-mono text-sm">
                         {currentCardIndex + 1} / {paper.flashCards.length}
                      </span>
                      <button 
                        onClick={nextCard}
                        className="p-3 rounded-full bg-panel border border-line text-muted hover:bg-surface hover:text-scholarly-600 transition-colors shadow-sm"
                      >
                         <ChevronRight className="w-6 h-6" />
                      </button>
                   </div>
                </div>
             </div>
          )}

          {/* Empty States */}
          {activeTab === 'quiz' && (!paper.quiz || paper.quiz.length === 0) && (
              <div className="flex flex-col items-center justify-center h-64 text-subtle">
                <BrainCircuit className="w-12 h-12 mb-4 opacity-30" />
                <p>No quiz questions generated for this paper.</p>
              </div>
          )}
           {activeTab === 'flashcards' && (!paper.flashCards || paper.flashCards.length === 0) && (
              <div className="flex flex-col items-center justify-center h-64 text-subtle">
                <Layers className="w-12 h-12 mb-4 opacity-30" />
                <p>No flashcards generated for this paper.</p>
              </div>
          )}
          
          <div className="p-8 text-center border-t border-line bg-panel">
            <p className="text-subtle text-sm italic">
              Generated by ScholarMind AI
            </p>
          </div>
        </div>
      </div>
      
      {/* Citation Modal */}
      {showCitationModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowCitationModal(false)}>
           <div className="bg-panel rounded-xl shadow-2xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-6 py-4 border-b border-line">
                 <h3 className="font-bold text-ink text-lg">Cite this paper</h3>
                 <button onClick={() => setShowCitationModal(false)} className="text-subtle hover:text-ink transition-colors">
                    <X className="w-5 h-5" />
                 </button>
              </div>
              
              <div className="p-6">
                 <p className="text-sm text-muted mb-3 font-medium">BibTeX Format</p>
                 <div className="bg-slate-900 text-subtle p-4 rounded-xl font-mono text-xs overflow-x-auto mb-6 shadow-inner border border-slate-800">
                    <pre className="whitespace-pre-wrap break-all">{getBibTeX()}</pre>
                 </div>
                 
                 <div className="flex gap-3 justify-end">
                    <button 
                      onClick={() => setShowCitationModal(false)}
                      className="px-4 py-2 text-muted hover:bg-panel-2 rounded-lg text-sm font-medium transition-colors"
                    >
                       Cancel
                    </button>
                    <button 
                      onClick={handleCopyCitation}
                      className="flex items-center gap-2 px-4 py-2 bg-scholarly-600 text-white rounded-lg hover:bg-scholarly-700 font-medium text-sm shadow-md shadow-scholarly-200 transition-all active:scale-95"
                    >
                       <Copy className="w-4 h-4" /> Copy to Clipboard
                    </button>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default BlogReader;