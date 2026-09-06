import { Paper, SourceKind } from '../types';
import { ai, ask, extractJson, extractText, MODELS, urlContextTool, retryWithBackoff } from './gemini';

/**
 * Turns anything a user can add — a link, a video, an upload — into the same
 * shape the rest of the pipeline already handles: a title, a summary, and the
 * text it says.
 *
 * Extraction happens once, at add time. Indexing, generation and export all
 * read `extractedText` rather than re-fetching or re-transcribing, so a video
 * is watched once no matter how many times it is used.
 *
 * The Interactions API takes typed content blocks, NOT the `parts` array that
 * generateContent uses — `{type:'video', uri}` works, `{parts:[{fileData}]}`
 * returns `400 Unknown parameter 'parts'`. Verified against the live API.
 */

const YOUTUBE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?|shorts\/|live\/)|youtu\.be\/)/i;
const WIKIPEDIA = /^(https?:\/\/)?([a-z-]+\.)?(wikipedia|wikimedia)\.org\//i;

/** Classifies a pasted link. Uploads carry their kind from the mime type instead. */
export const detectKind = (url: string): SourceKind => {
  const trimmed = (url || '').trim();
  if (YOUTUBE.test(trimmed)) return 'youtube';
  if (WIKIPEDIA.test(trimmed)) return 'wikipedia';
  if (/\.pdf($|\?)/i.test(trimmed)) return 'document';
  return 'web';
};

export const kindForMime = (mime: string): SourceKind => {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
};

export const isSupportedUpload = (mime: string): boolean =>
  /^(audio|video)\//.test(mime) ||
  ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'].includes(mime);

/** Interactions content-block type for a media mime. */
const blockTypeFor = (mime: string): 'audio' | 'video' | 'document' =>
  mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document';

const METADATA_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    year: { type: 'string' },
  },
  required: ['title', 'summary'],
} as const;

export interface ExtractedSource {
  title: string;
  summary: string;
  authors: string[];
  year: string;
  /** The full text: a transcript, a page's content, a document's body. */
  text: string;
}

const FAILED = (fallbackTitle: string): ExtractedSource => ({
  title: fallbackTitle,
  summary: 'This source could not be read.',
  authors: [],
  year: '',
  text: '',
});

/**
 * Two calls, deliberately. The first reads the source with whatever tool or
 * media block it needs; the second structures the result with no tool attached.
 * This is the same two-stage shape `generatePaperResources` uses, and for the
 * same reason — grounded structured output is corrupted at the first array.
 */
const structure = async (content: string, fallbackTitle: string): Promise<ExtractedSource> => {
  const interaction = await ask({
    input: `Here is the content of a source. Return a title, a two-sentence summary, any
authors or creators, and a year if one is evident.

CONTENT:
${content.slice(0, 30000)}`,
    schema: METADATA_SCHEMA,
  });
  const data = extractJson<Partial<ExtractedSource>>(interaction, {});
  return {
    title: data.title || fallbackTitle,
    summary: data.summary || '',
    authors: data.authors || [],
    year: data.year || '',
    text: content,
  };
};

/** Reads a web page or a Wikipedia article through the URL context tool. */
const fromUrl = async (url: string, kind: SourceKind): Promise<ExtractedSource> => {
  const interaction = await ask({
    input: `Read ${url} and write out its substantive content in plain prose: what it
covers, its argument or findings, and the specifics — names, numbers, dates,
definitions. Aim for completeness over brevity. Do not editorialise.`,
    tools: [urlContextTool()],
  });
  const content = extractText(interaction);
  if (!content) return FAILED(url);
  return structure(content, kind === 'wikipedia' ? url.split('/').pop() || url : url);
};

/** Watches a YouTube video. The URL is passed straight through — no download. */
const fromYouTube = async (url: string): Promise<ExtractedSource> => {
  const interaction = await retryWithBackoff(() =>
    ai().interactions.create({
      model: MODELS.text,
      input: [
        {
          type: 'text',
          text: `Describe what this video covers, in detail and in plain prose: its
argument or subject, the specifics stated, and any conclusions. Write it so that
someone who has not watched it could answer questions about it.`,
        },
        { type: 'video', uri: url },
      ],
    } as any)
  );
  const content = extractText(interaction);
  if (!content) return FAILED(url);
  return structure(content, url);
};

/**
 * Uploaded bytes go through the Files API, which is asynchronous — video in
 * particular sits in PROCESSING for a while, and using the URI before it turns
 * ACTIVE fails.
 */
const uploadToFiles = async (data: Buffer, mime: string, name: string) => {
  const uploaded = await retryWithBackoff(() =>
    ai().files.upload({
      file: new Blob([new Uint8Array(data)], { type: mime }),
      config: { mimeType: mime, displayName: name.slice(0, 60) },
    })
  );

  let file = uploaded;
  for (let attempt = 0; attempt < 40 && file.state === 'PROCESSING'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    file = await ai().files.get({ name: uploaded.name! });
  }
  if (file.state !== 'ACTIVE') throw new Error(`Upload did not become usable (state: ${file.state})`);
  return file;
};

const PROMPTS: Record<string, string> = {
  audio: `Transcribe this audio in full. Then, after the transcript, describe what it
covers and any specifics stated — names, numbers, claims.`,
  video: `Describe what this video covers, in detail and in plain prose, including
anything said aloud and anything shown that carries meaning.`,
  document: `Write out this document's substantive content in plain prose: what it
covers, its argument or findings, and the specifics — names, numbers, definitions.
Aim for completeness over brevity.`,
};

const fromUpload = async (
  data: Buffer,
  mime: string,
  fileName: string
): Promise<ExtractedSource> => {
  const file = await uploadToFiles(data, mime, fileName);
  const blockType = blockTypeFor(mime);
  try {
    const interaction = await retryWithBackoff(() =>
      ai().interactions.create({
        model: MODELS.text,
        input: [
          { type: 'text', text: PROMPTS[blockType] },
          { type: blockType, uri: file.uri, mime_type: mime },
        ],
      } as any)
    );
    const content = extractText(interaction);
    if (!content) return FAILED(fileName);
    return structure(content, fileName);
  } finally {
    // The Files API keeps uploads for 48 hours; the bytes are already in the
    // blob store, so releasing immediately keeps the quota clean.
    await ai().files.delete({ name: file.name! }).catch(() => {});
  }
};

export const extractFromUrl = async (url: string, kind: SourceKind): Promise<ExtractedSource> => {
  try {
    return kind === 'youtube' || kind === 'video' ? await fromYouTube(url) : await fromUrl(url, kind);
  } catch (error) {
    console.error(`Could not read ${kind} source ${url}:`, error);
    return FAILED(url);
  }
};

export const extractFromUpload = async (
  data: Buffer,
  mime: string,
  fileName: string
): Promise<ExtractedSource> => {
  try {
    return await fromUpload(data, mime, fileName);
  } catch (error) {
    console.error(`Could not read uploaded ${mime} (${fileName}):`, error);
    return FAILED(fileName);
  }
};

/** What gets embedded for a non-paper source. */
export const indexableText = (paper: Paper): string =>
  [
    `Title: ${paper.title}`,
    paper.kind && paper.kind !== 'paper' ? `Source type: ${paper.kind}` : '',
    paper.sourceUrl ? `Source: ${paper.sourceUrl}` : '',
    (paper.authors ?? []).length ? `Authors: ${(paper.authors ?? []).join(', ')}` : '',
    paper.year ? `Year: ${paper.year}` : '',
    '',
    paper.summary ?? '',
    '',
    paper.extractedText ?? '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
