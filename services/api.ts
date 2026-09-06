import { Citation, Message, Paper } from '../types';

export interface ProfileRecord {
  id: string;
  ownerId: string;
  title: string;
  emoji: string;
  theme: string;
  createdAt: number;
  updatedAt: number;
  scholarName?: string;
  affiliation?: string;
  topics?: string[];
  fileSearchStoreName?: string;
  scholarKeys?: string[];
}

/** Errors carry the response body, so callers can act on a structured refusal. */
export interface ApiError extends Error {
  status: number;
  data: any;
}

const json = async (res: Response) => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${res.status})`) as ApiError;
    error.status = res.status;
    error.data = body;
    throw error;
  }
  return res.json();
};

const send = (path: string, method: string, body?: unknown) =>
  fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

// --- Profiles ---------------------------------------------------------------
export const listProfiles = (): Promise<ProfileRecord[]> => send('/profiles', 'GET');

export const createProfile = (title: string, emoji: string): Promise<ProfileRecord> =>
  send('/profiles', 'POST', { title, emoji });

export const getProfile = (
  id: string
): Promise<{ profile: ProfileRecord; papers: Paper[]; messages: Message[] }> =>
  send(`/profiles/${id}`, 'GET');

export const updateProfile = (id: string, patch: Partial<ProfileRecord>): Promise<ProfileRecord> =>
  send(`/profiles/${id}`, 'PATCH', patch);

export const deleteProfile = (id: string): Promise<void> => send(`/profiles/${id}`, 'DELETE');

// --- Discovery (the landing page) -------------------------------------------
export interface DiscoveredProfile {
  id: string;
  title: string;
  emoji: string;
  scholarName?: string;
  affiliation?: string;
  topics: string[];
  sourceCount: number;
  indexedCount: number;
  updatedAt: number;
  /** True when the scholar identity matches, rather than just the text. */
  exact: boolean;
}

export const discover = (query: string): Promise<{ query: string; matches: DiscoveredProfile[] }> =>
  send(`/discover?q=${encodeURIComponent(query)}`, 'GET');

// --- Papers -----------------------------------------------------------------
/** A profile the user already has for this scholar, returned with a 409. */
export interface DuplicateProfile {
  id: string;
  title: string;
  scholarName?: string;
  paperCount: number;
}

export const searchScholar = (
  profileId: string,
  query: string,
  allowDuplicate = false
): Promise<{ profile: ProfileRecord; papers: Paper[] }> =>
  send(`/profiles/${profileId}/search`, 'POST', { query, allowDuplicate });

export const findPaper = (profileId: string, query: string): Promise<Paper> =>
  send(`/profiles/${profileId}/papers/find`, 'POST', { query });

/** Adds any link — a page, a Wikipedia article, a YouTube video, a PDF. */
export const addSourceUrl = (profileId: string, url: string): Promise<Paper> =>
  send(`/profiles/${profileId}/sources`, 'POST', { url });

/** Adds an uploaded document, audio or video file. */
export const uploadSource = async (profileId: string, file: File): Promise<Paper> => {
  const form = new FormData();
  form.append('file', file);
  return json(
    await fetch(`/api/profiles/${profileId}/sources/upload`, { method: 'POST', body: form })
  );
};

export const fetchCitations = (profileId: string, paperId: string): Promise<Paper[]> =>
  send(`/profiles/${profileId}/papers/${paperId}/citations`, 'POST');

export const listPapers = (profileId: string): Promise<Paper[]> =>
  send(`/profiles/${profileId}/papers`, 'GET');

// --- Messages ---------------------------------------------------------------
export const appendMessage = (profileId: string, message: Message): Promise<void> =>
  send(`/profiles/${profileId}/messages`, 'POST', message);

export const clearMessages = (profileId: string): Promise<void> =>
  send(`/profiles/${profileId}/messages`, 'DELETE');

// --- Media ------------------------------------------------------------------
/** Blob keys are server-issued and ownership-checked, so they are safe in markup. */
export const blobUrl = (key?: string): string | undefined => (key ? `/api/blobs/${key}` : undefined);

export const exportUrl = (profileId: string): string => `/api/profiles/${profileId}/export`;

export const speak = async (text: string, voice: string): Promise<Blob | null> => {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  return res.ok ? res.blob() : null;
};

// --- Server-sent events -----------------------------------------------------
type SseHandlers = Record<string, (data: any) => void>;

const consumeSse = async (path: string, body: unknown, handlers: SseHandlers): Promise<void> => {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try {
        handlers[event]?.(JSON.parse(data.join('\n')));
      } catch {
        // A malformed frame should not tear down the stream.
      }
    }
  }
};

/** 'index' makes papers searchable; 'artifacts' writes the blog, slides and media. */
export type PipelineMode = 'index' | 'artifacts' | 'both';

export const processPapers = (
  profileId: string,
  paperIds: string[],
  mode: PipelineMode,
  onPaper: (paper: Paper) => void,
  onDone?: () => void,
  onError?: (message: string) => void
): Promise<void> =>
  consumeSse(`/profiles/${profileId}/process`, { paperIds, mode }, {
    paper: onPaper,
    done: () => onDone?.(),
    error: d => onError?.(d?.message ?? 'Processing failed'),
  });

export const streamChat = (
  /** null asks across every library — what the landing page does. */
  profileId: string | null,
  message: string,
  useWebSearch: boolean,
  onDelta: (text: string) => void,
  onDone?: (info: {
    grounded: boolean;
    fellBack?: boolean;
    indexed?: number;
    pending?: number;
    searchedLibraries?: string[];
    skippedLibraries?: number;
  }) => void,
  onError?: (message: string) => void,
  onCitations?: (citations: Citation[]) => void
): Promise<void> =>
  consumeSse('/chat', { profileId, message, useWebSearch }, {
    delta: d => onDelta(d?.text ?? ''),
    citations: d => onCitations?.(d?.citations ?? []),
    done: d => onDone?.(d ?? { grounded: false }),
    error: d => onError?.(d?.message ?? 'Chat failed'),
  });

// --- One-time migration -----------------------------------------------------
export const LEGACY_KEY = 'scholarMind_profiles_v1';

export const importLegacy = (payload: unknown): Promise<{ ok: boolean; imported: string[] }> =>
  send('/import/localstorage', 'POST', payload);

export const deletePaper = (profileId: string, paperId: string): Promise<void> =>
  send(`/profiles/${profileId}/papers/${paperId}`, 'DELETE');
