import React, { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Quote, X } from 'lucide-react';
import * as api from '../services/api';

interface CiteDialogProps {
  profileId: string;
  paperId: string;
  onClose: () => void;
}

const LABELS: Record<api.CitationStyle, string> = {
  bibtex: 'BibTeX',
  apa: 'APA',
  mla: 'MLA',
  chicago: 'Chicago',
  harvard: 'Harvard',
  ris: 'RIS',
};

/**
 * Every style for one source, fetched in a single call, so switching between
 * them is instant and does not re-hit Crossref.
 */
const CiteDialog: React.FC<CiteDialogProps> = ({ profileId, paperId, onClose }) => {
  const [data, setData] = useState<api.PaperCitations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<api.CitationStyle>('bibtex');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .paperCitations(profileId, paperId)
      .then(result => !cancelled && setData(result))
      .catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [profileId, paperId]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.citations[style]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not reach the clipboard. Select the text and copy it manually.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-panel rounded-2xl shadow-2xl border border-line w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <Quote className="w-4 h-4 text-scholarly-600 shrink-0" />
            <h3 className="font-semibold text-ink truncate">{data?.title ?? 'Cite'}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-panel-2 text-muted hover:text-ink">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6">
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
          ) : !data ? (
            <div className="flex items-center gap-2 text-muted text-sm py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Looking up bibliographic details...
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {api.CITATION_STYLES.map(s => (
                  <button
                    key={s}
                    onClick={() => setStyle(s)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                      style === s
                        ? 'bg-scholarly-600 text-white border-scholarly-600'
                        : 'bg-panel text-muted border-line hover:text-ink hover:border-scholarly-300'
                    }`}
                  >
                    {LABELS[s]}
                  </button>
                ))}
              </div>

              <pre className="bg-panel-2 border border-line rounded-xl p-4 text-xs font-mono text-ink whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                {data.citations[style]}
              </pre>

              <div className="flex items-center justify-between gap-4 mt-4">
                <p className="text-xs text-muted">
                  {data.hasBibliographicData
                    ? 'Journal, volume and pages came from Crossref.'
                    : 'No Crossref record matched, so only what this library holds is shown — nothing has been invented to fill the gaps.'}
                </p>
                <button
                  onClick={copy}
                  className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-scholarly-600 text-white text-sm font-semibold hover:bg-scholarly-700 transition-all active:scale-95"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CiteDialog;
