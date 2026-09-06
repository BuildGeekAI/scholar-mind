import React, { useState, useRef, useEffect } from 'react';
import { Message } from '../types';
import { Send, Bot, User, Sparkles, Search, X, PanelRightClose, Mic, MicOff, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ChatInterfaceProps {
  messages: Message[];
  onSendMessage: (text: string, useWebSearch?: boolean) => void;
  /** How many papers are searchable. Zero means the library cannot ground anything yet. */
  indexedCount?: number;
  isProcessing: boolean;
  readyToChat: boolean;
  onClose?: () => void;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({ messages, onSendMessage, isProcessing, readyToChat, onClose, indexedCount = 0 }) => {
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [input, setInput] = useState('');
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isListening, setIsListening] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, searchQuery, isSearchVisible]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing) return;
    onSendMessage(input, useWebSearch);
    setInput('');
  };

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Dictation is not supported in this browser. Please use Chrome, Edge, or Safari.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
    };

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(prev => {
        const trimmed = prev.trim();
        return trimmed ? `${trimmed} ${transcript}` : transcript;
      });
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const filteredMessages = messages.filter(msg => 
    msg.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full bg-surface border-l border-line">
      {/* Chat Header */}
      <div className="bg-panel p-4 border-b border-line flex items-center justify-between shadow-sm h-[72px] shrink-0">
        {isSearchVisible ? (
          <div className="flex items-center w-full gap-2 animate-in fade-in duration-200">
            <Search className="w-5 h-5 text-subtle" />
            <input 
              type="text" 
              placeholder="Search history..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
              className="flex-1 bg-surface border-none focus:ring-0 text-sm text-ink placeholder-subtle h-9 rounded-md px-2"
            />
            <button 
              onClick={() => {
                setIsSearchVisible(false);
                setSearchQuery('');
              }}
              className="p-2 text-subtle hover:text-ink hover:bg-panel-2 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="bg-scholarly-100 p-2 rounded-lg text-scholarly-600">
                 <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-semibold text-ink">Scholar Bot</h2>
                <p className="text-xs text-muted">
                  Assistant & Analysis
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-1">
                {messages.length > 0 && (
                <button 
                    onClick={() => setIsSearchVisible(true)}
                    className="p-2 text-subtle hover:text-scholarly-600 hover:bg-scholarly-50 rounded-full transition-colors"
                    title="Search chat history"
                >
                    <Search className="w-5 h-5" />
                </button>
                )}
                {onClose && (
                    <button 
                        onClick={onClose}
                        className="p-2 text-subtle hover:text-ink hover:bg-panel-2 rounded-full transition-colors"
                        title="Close Chat"
                    >
                        <PanelRightClose className="w-5 h-5" />
                    </button>
                )}
            </div>
          </>
        )}
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-subtle text-center p-6">
            <Bot className="w-12 h-12 mb-4 opacity-20" />
            <p className="text-sm leading-relaxed">
              I can answer questions about the papers.<br/>
              Try asking: <em>"What is the main contribution?"</em>
            </p>
            <div className="w-full h-px bg-line my-4 max-w-[200px]"></div>
            <p className="text-xs text-scholarly-600 font-medium">
              Want to add a paper? <br/>
              Type <strong>"analyze [Paper Title]"</strong>
            </p>
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-subtle text-center">
            <Search className="w-10 h-10 mb-2 opacity-20" />
            <p className="text-sm">No messages match your search.</p>
          </div>
        ) : (
          filteredMessages.map((msg) => (
            <div 
              key={msg.id} 
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'model' && (
                <div className="w-8 h-8 rounded-full bg-scholarly-100 flex items-center justify-center text-scholarly-700 shrink-0 mt-1">
                  <Bot className="w-5 h-5" />
                </div>
              )}
              
              <div 
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === 'user' 
                    ? 'bg-scholarly-600 text-white rounded-br-none' 
                    : 'bg-panel border border-line text-ink rounded-bl-none shadow-sm'
                }`}
              >
                <ReactMarkdown>{msg.content}</ReactMarkdown>

                {/* Sources File Search actually retrieved for this answer. */}
                {!!msg.citations?.length && (
                  <details className="mt-3 pt-2 border-t border-line">
                    <summary className="text-xs font-medium text-muted cursor-pointer hover:text-scholarly-600 select-none">
                      {msg.citations.length} source{msg.citations.length === 1 ? '' : 's'} from your library
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {msg.citations.map((c, i) => (
                        <li key={i} className="text-xs bg-surface rounded-lg p-2 border border-line">
                          <div className="flex items-start gap-1.5 font-medium text-ink">
                            <FileText className="w-3.5 h-3.5 shrink-0 mt-px text-scholarly-500" />
                            <span className="line-clamp-2">{c.fileName}</span>
                          </div>
                          {c.snippet && (
                            <p className="mt-1 text-muted italic leading-snug line-clamp-3">“{c.snippet}”</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-line flex items-center justify-center text-muted shrink-0 mt-1">
                  <User className="w-5 h-5" />
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 bg-panel border-t border-line shrink-0">
        <div className="flex items-center gap-2 mb-2 text-xs">
          <button
            type="button"
            onClick={() => setUseWebSearch(v => !v)}
            title="File search and web search cannot be combined in one request, so each message uses one or the other."
            className={`px-2.5 py-1 rounded-full font-medium transition-colors border ${
              useWebSearch
                ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-200'
                : indexedCount > 0
                  ? 'bg-scholarly-50 text-scholarly-700 border-scholarly-200'
                  : 'bg-panel-2 text-muted border-line'
            }`}
          >
            {useWebSearch
              ? '🌐 Searching the web'
              : indexedCount > 0
                ? `📚 Using your library (${indexedCount})`
                : '📚 Library is empty'}
          </button>
          <span className="text-subtle">
            {!useWebSearch && indexedCount === 0 ? 'press Index to embed papers' : 'tap to switch'}
          </span>
        </div>
        <form onSubmit={handleSubmit} className="flex items-center gap-2 relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isListening ? "Listening..." : "Ask a question or type 'analyze [Paper]'"}
            disabled={!readyToChat || isProcessing}
            className={`w-full bg-panel-2 border text-ink rounded-xl pl-4 pr-20 py-3 focus:outline-none focus:ring-2 focus:ring-scholarly-500/50 transition-all disabled:opacity-60 ${isListening ? 'border-red-400 ring-2 ring-red-100 placeholder-red-400' : 'border-line'}`}
          />
          
          <div className="absolute right-2 flex items-center gap-1">
             <button
                type="button"
                onClick={toggleListening}
                disabled={!readyToChat || isProcessing}
                className={`p-2 rounded-lg transition-all ${
                    isListening 
                    ? 'bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-300 animate-pulse hover:bg-red-200' 
                    : 'text-subtle hover:bg-line hover:text-ink'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                title="Dictate"
             >
                {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
             </button>

             <button
                type="submit"
                disabled={!input.trim() || !readyToChat || isProcessing}
                className="p-2 bg-scholarly-600 text-white rounded-lg hover:bg-scholarly-700 disabled:bg-line disabled:cursor-not-allowed transition-colors shadow-sm"
             >
                <Send className="w-4 h-4" />
             </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ChatInterface;