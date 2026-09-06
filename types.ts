
export interface Slide {
  title: string;
  points: string[];
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number; // index of the correct option (0-3)
  explanation: string;
}

export interface FlashCard {
  front: string;
  back: string;
}

/**
 * A profile holds more than papers. Every kind is normalized to text on the way
 * in, so indexing, generation, chat and export stay identical downstream.
 */
export type SourceKind =
  | 'paper'
  | 'web'
  | 'wikipedia'
  | 'youtube'
  | 'video'
  | 'audio'
  | 'document';

export interface Paper {
  id: string;
  /** Absent on records written before sources existed; treat as 'paper'. */
  kind?: SourceKind;
  title: string;
  year: string;
  authors: string[];
  summary: string;
  citationCount?: string;
  /** Artifact-generation lifecycle. Indexing is tracked separately, below. */
  status: 'discovered' | 'downloading' | 'processing' | 'converted' | 'error';
  blogContent?: string;
  blogTitle?: string;
  slides?: Slide[];
  quiz?: QuizQuestion[];
  flashCards?: FlashCard[];
  audioScript?: string;
  citingPapers?: Paper[];

  // Server-persisted artifacts. Bytes live in the blob store; these are pointers.
  illustrationKey?: string;
  illustrationMime?: string;
  audioKey?: string;
  audioMime?: string;
  pdfKey?: string;
  sourceUrl?: string;
  pdfStatus?: 'pending' | 'found' | 'fetched' | 'unavailable' | 'error';
  /** Current pipeline step while processing; cleared when the paper settles. */
  stage?: 'resolving' | 'fetching' | 'indexing' | 'writing' | 'media';
  fileSearchDocName?: string;
  /**
   * Indexing runs independently of artifact generation, so it carries its own
   * status: `status` above tracks only the blog/slides/audio/art half.
   */
  indexStatus?: 'indexing' | 'indexed' | 'error';
  /** Whether the indexed document is the paper's full text or a written summary. */
  indexedKind?: 'pdf' | 'summary';
  /**
   * The PDF came from the shared corpus — another profile had already resolved
   * and downloaded it, so this index skipped both steps.
   */
  pdfReused?: boolean;

  // --- Non-paper sources ---------------------------------------------------
  /** Blob key of an uploaded document, audio or video file. */
  mediaKey?: string;
  mediaMime?: string;
  /** Original filename, for uploads. */
  fileName?: string;
  /**
   * What the source says, extracted once at add time: a transcript for audio
   * and video, the page text for a URL. Everything downstream reads this
   * rather than re-fetching the source.
   */
  extractedText?: string;
  /** Duration for audio and video, in seconds, when the model reports one. */
  durationSeconds?: number;
}

export interface Citation {
  /** Display name of the indexed document the claim came from. */
  fileName: string;
  documentUri: string;
  /** Excerpt of the source passage, trimmed for display. */
  snippet: string;
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  citations?: Citation[];
}

export interface ScholarData {
  name: string;
  affiliation?: string;
  topics?: string[];
  papers: Paper[];
}

export interface Profile {
  id: string;
  title: string;
  emoji: string;
  createdAt: number;
  updatedAt: number;
  scholar: ScholarData | null;
  chatMessages: Message[];
  theme: string;
}

export enum AppState {
  IDLE,
  SEARCHING,
  PROCESSING,
  READY
}

/**
 * The localStorage-era shapes. Retained solely so the one-time import endpoint
 * can read old browser data; nothing else should reference them.
 */
export interface LegacyPaper extends Paper {
  audioBase64?: string;
  illustration?: string;
}

export interface LegacyScholarData extends Omit<ScholarData, 'papers'> {
  papers: LegacyPaper[];
}

export interface LegacyProfile extends Omit<Profile, 'scholar'> {
  scholar: LegacyScholarData | null;
}
