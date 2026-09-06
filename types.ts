
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
  audioBase64?: string;
  illustration?: string;
  citingPapers?: Paper[];
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
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

export type ScholarProfile = ScholarData;

export interface Notebook {
  id: string;
  title: string;
  emoji: string;
  createdAt: number;
  updatedAt: number;
  profile: ScholarProfile | null;
  chatMessages: Message[];
  theme: string;
}
