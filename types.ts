
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

export interface Paper {
  id: string;
  title: string;
  year: string;
  authors: string[];
  summary: string;
  citationCount?: string;
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
