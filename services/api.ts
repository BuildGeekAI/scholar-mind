import { Citation, Message, Paper } from '../types';

export type Visibility = 'private' | 'team' | 'org';
export type Role = 'viewer' | 'editor' | 'owner';

export interface ProfileRecord {
  id: string;
  ownerId: string;
  orgId: string;
  teamId: string;
  /** Public by default: readable by every member of the owner's org. */
  visibility: Visibility;
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

  /** A profile becomes an advisor when this is set; everything else stays. */
  advisorEnabled?: boolean;
  advisorName?: string;
  advisorTitle?: string;
  /** Voice and stance only — never facts. */
  advisorBrief?: string;
  advisorAvatarKey?: string;
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

/**
 * Starts a crawl. Resolving a scholar and indexing sixty papers takes minutes,
 * so this returns a run to poll rather than the papers themselves. The obvious
 * duplicate still comes back immediately as a 409; the one that needs the
 * resolved name surfaces on the run as `detail.duplicate`.
 */
export const searchScholar = (
  profileId: string,
  query: string,
  allowDuplicate = false,
  /** Overrides the server default (20). Capped at 50 server-side. */
  paperLimit?: number
): Promise<{ runId: string | null; profile: ProfileRecord; alreadyRunning?: boolean }> =>
  send(`/profiles/${profileId}/search`, 'POST', { query, allowDuplicate, paperLimit });

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

// --- Citations --------------------------------------------------------------
export type CitationStyle = 'bibtex' | 'apa' | 'mla' | 'chicago' | 'harvard' | 'ris';

export const CITATION_STYLES: CitationStyle[] = ['bibtex', 'apa', 'mla', 'chicago', 'harvard', 'ris'];

export interface PaperCitations {
  id: string;
  title: string;
  /** False when Crossref had no matching record, so fields are thin but honest. */
  hasBibliographicData: boolean;
  citations: Record<CitationStyle, string>;
}

export const paperCitations = (profileId: string, paperId: string): Promise<PaperCitations> =>
  send(`/profiles/${profileId}/papers/${paperId}/citation`, 'GET');

export const bibliography = (
  profileId: string,
  style: CitationStyle
): Promise<{ style: CitationStyle; count: number; text: string }> =>
  send(`/profiles/${profileId}/citations?style=${style}`, 'GET');

export const bibliographyUrl = (profileId: string, style: CitationStyle): string =>
  `/api/profiles/${profileId}/citations?style=${style}&download=1`;

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

// --- Runs, status and the queue ---------------------------------------------
// Processing no longer streams. The work outlives the request that started it —
// a reload, a navigation or a dead connection must not abandon a crawl — so the
// request enqueues and returns a run id, and the client polls that.

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  profileId: string;
  kind: string;
  status: RunStatus;
  detail: {
    /** Present when a crawl stopped because the scholar is already in a library. */
    duplicate?: DuplicateProfile;
    papersFound?: number;
    scholarName?: string;
    [key: string]: any;
  };
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
}

export interface RunProgress {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
}

export type StageState = 'pending' | 'running' | 'done' | 'error' | 'unavailable';

export interface PaperStatus {
  id: string;
  title: string;
  stage: string | null;
  download: StageState;
  enrich: StageState;
  index: StageState;
}

export const TERMINAL_RUN_STATUSES: RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

export const isRunFinished = (run: Run | null | undefined): boolean =>
  !!run && TERMINAL_RUN_STATUSES.includes(run.status);

/** Enqueues the pipeline. Returns the run to poll, or null if it was all already in flight. */
export const processPapers = (
  profileId: string,
  paperIds: string[],
  mode: PipelineMode
): Promise<{ runId: string | null; enqueued: number; skipped: number; alreadyRunning?: boolean }> =>
  send(`/profiles/${profileId}/process`, 'POST', { paperIds, mode });

export const getRun = (runId: string): Promise<{ run: Run; progress: RunProgress }> =>
  send(`/runs/${runId}`, 'GET');

export const profileStatus = (
  profileId: string
): Promise<{ run: Run | null; progress: RunProgress | null; papers: PaperStatus[] }> =>
  send(`/profiles/${profileId}/status`, 'GET');

// --- Sharing ----------------------------------------------------------------

export interface Grant {
  id: string;
  principalType: 'user' | 'team' | 'org';
  principalId: string;
  role: Role;
  email?: string;
  name?: string;
}

export interface Sharing {
  visibility: Visibility;
  role: Role | null;
  grants: Grant[];
  candidates: Array<{ id: string; email: string; name?: string }>;
}

export const getSharing = (profileId: string): Promise<Sharing> =>
  send(`/profiles/${profileId}/sharing`, 'GET');

export const shareWith = (
  profileId: string,
  email: string,
  role: Role = 'viewer'
): Promise<{ ok: boolean; grants: Grant[] }> =>
  send(`/profiles/${profileId}/sharing`, 'POST', { email, role });

export const unshare = (
  profileId: string,
  principalId: string,
  principalType = 'user'
): Promise<{ ok: boolean; grants: Grant[] }> =>
  send(
    `/profiles/${profileId}/sharing?principalType=${principalType}&principalId=${principalId}`,
    'DELETE'
  );

export const setVisibility = (profileId: string, visibility: Visibility): Promise<ProfileRecord> =>
  updateProfile(profileId, { visibility });

// --- Search -----------------------------------------------------------------

export type SearchScope = 'me' | 'team' | 'org' | 'profile';

export interface SearchHit {
  chunkId: string;
  text: string;
  ordinal: number;
  paperId: string;
  paperTitle: string;
  profileId: string;
  profileTitle: string;
  score: number;
  matched: Array<'keyword' | 'semantic'>;
}

/** Across every library the caller can reach — however many that is. */
export const searchLibraries = (
  q: string,
  options: { scope?: SearchScope; profileId?: string; limit?: number } = {}
): Promise<{ query: string; scope: SearchScope; hits: SearchHit[] }> => {
  const params = new URLSearchParams({ q });
  if (options.scope) params.set('scope', options.scope);
  if (options.profileId) params.set('profileId', options.profileId);
  if (options.limit) params.set('limit', String(options.limit));
  return send(`/search?${params}`, 'GET');
};

// --- Identity ---------------------------------------------------------------

export interface Me {
  email: string;
  name?: string;
  picture?: string;
  orgId: string;
  teamId: string;
  /** True when this call was authenticated with an API key rather than a session. */
  viaKey: boolean;
  scope: 'read' | 'write' | null;
}

/** Who the server thinks we are. A 401 means "not signed in". */
export const me = (): Promise<Me> => send('/auth/me', 'GET');

export interface AuthConfig {
  firebase: boolean;
  projectId: string;
  /** Public by design: it identifies the project and authorises nothing. */
  apiKey: string;
}

export const authConfig = (): Promise<AuthConfig> => send('/auth/config', 'GET');

/**
 * Trades a Firebase ID token for a session cookie. Everything after this is an
 * ordinary cookie request — no Authorization header, no token refresh.
 */
export const exchangeFirebaseToken = (idToken: string): Promise<{ email: string; name?: string }> =>
  send('/auth/firebase', 'POST', { idToken });

export const signOut = async (): Promise<void> => {
  await send('/auth/signout', 'POST').catch(() => {
    // Already signed out, or the session expired. Either way, leave.
  });
  window.location.href = '/';
};

// --- API keys ---------------------------------------------------------------
// A key acts as you: it inherits your libraries and your grants exactly, and a
// scope can only narrow what it may do.

export type KeyScope = 'read' | 'write';

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scope: KeyScope;
  lastUsedAt?: number;
  expiresAt?: number;
  createdAt: number;
}

export const listApiKeys = (): Promise<ApiKeyRecord[]> => send('/keys', 'GET');

/**
 * The response carries the key itself. It is the only time it is ever
 * returned — the server stores a hash — so it has to be shown to the user
 * immediately and cannot be fetched again.
 */
export const createApiKey = (
  name: string,
  scope: KeyScope = 'read',
  expiresInDays?: number
): Promise<{ key: string; record: ApiKeyRecord }> =>
  send('/keys', 'POST', { name, scope, expiresInDays });

export const revokeApiKey = (id: string): Promise<void> => send(`/keys/${id}`, 'DELETE');

// --- Advisors ---------------------------------------------------------------
// An advisor is a profile with a persona. Consulting one is reading someone's
// published work through a voice — never a simulation of the person.

export interface Advisor extends ProfileRecord {
  /** Papers in the search index. An advisor with none has nothing to draw on. */
  indexedCount: number;
  /** How many hold real content rather than just an abstract. */
  deepCount: number;
  mine: boolean;
}

export const listAdvisors = (): Promise<Advisor[]> => send('/advisors', 'GET');

export const updateAdvisor = (
  profileId: string,
  patch: { enabled?: boolean; name?: string; title?: string; brief?: string }
): Promise<ProfileRecord> => send(`/profiles/${profileId}/advisor`, 'PATCH', patch);

export interface AdvisorCitation {
  paperId: string;
  paperTitle: string;
  profileId: string;
  snippet: string;
}

export interface AdvisorAnswer {
  profileId: string;
  advisorName: string;
  answer: string;
  citations: AdvisorCitation[];
  /** The passages did not cover the question, so no answer was invented. */
  abstained: boolean;
}

/**
 * Ask a panel. Streamed per advisor: each is a retrieval plus a model call, so
 * the first answer arrives well before the last.
 */
export const consult = (
  question: string,
  advisorIds: string[],
  options: { synthesise?: boolean } = {},
  handlers: {
    onAdvisor: (answer: AdvisorAnswer) => void;
    onSynthesis?: (text: string) => void;
    onDone?: (info: { consultationId: string; consulted: number; unavailable: number }) => void;
    onError?: (message: string) => void;
  }
): Promise<void> =>
  consumeSse('/consult', { question, advisorIds, synthesise: !!options.synthesise }, {
    advisor: d => handlers.onAdvisor(d as AdvisorAnswer),
    synthesis: d => handlers.onSynthesis?.(d?.synthesis ?? ''),
    done: d => handlers.onDone?.(d),
    error: d => handlers.onError?.(d?.message ?? 'Consultation failed'),
  });

export interface Consultation {
  id: string;
  question: string;
  synthesis?: string;
  createdAt: number;
  answers: Array<AdvisorAnswer & { hidden?: boolean }>;
}

export const listConsultations = (): Promise<Consultation[]> => send('/consultations', 'GET');

export const getConsultation = (id: string): Promise<Consultation> =>
  send(`/consultations/${id}`, 'GET');

// --- Crawlers ---------------------------------------------------------------

export interface Crawler {
  id: string;
  profileId: string;
  kind: string;
  target: string;
  intervalSeconds?: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
}

export const listCrawlers = (profileId?: string): Promise<Crawler[]> =>
  send(`/crawlers${profileId ? `?profileId=${profileId}` : ''}`, 'GET');

export const createCrawler = (
  profileId: string,
  target: string,
  intervalSeconds?: number
): Promise<Crawler> => send('/crawlers', 'POST', { profileId, target, intervalSeconds });

export const updateCrawler = (
  id: string,
  patch: { target?: string; intervalSeconds?: number | null; enabled?: boolean }
): Promise<Crawler> => send(`/crawlers/${id}`, 'PATCH', patch);

export const deleteCrawler = (id: string): Promise<void> => send(`/crawlers/${id}`, 'DELETE');

export const runCrawler = (id: string): Promise<{ runId: string }> =>
  send(`/crawlers/${id}/run`, 'POST');

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
