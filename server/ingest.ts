import { Paper } from '../types';
import { BlobStore, blobKey } from './blobStore';
import { generateAudio, generateIllustration, generatePaperResources } from './gemini';
import { deleteDocument, indexDocument } from './fileSearch';
import { fetchPdf, resolvePaperSource } from './paperSource';
import * as repo from './repository';

export type ProgressFn = (paper: Paper) => void | Promise<void>;

/**
 * The two halves of the pipeline run independently, because they answer
 * different questions: indexing makes a paper searchable in chat, artifact
 * generation makes it readable. Users want one without waiting for the other.
 */
export type PipelineMode = 'index' | 'artifacts' | 'both';

/**
 * Replaces the client's simulated download step. Acquisition failures degrade
 * rather than block: a missing PDF must never stop a paper from being indexed
 * or from producing content.
 */
const acquirePdf = async (
  profileId: string,
  paper: Paper,
  blobs: BlobStore,
  setStage: (stage: Paper['stage']) => Promise<void>
): Promise<{ patch: Partial<Paper>; bytes: Buffer | null }> => {
  // Already fetched on an earlier run: reuse the bytes instead of re-downloading.
  if (paper.pdfKey) {
    const stored = await blobs.get(paper.pdfKey).catch(() => null);
    if (stored) return { patch: {}, bytes: stored.data };
  }

  await setStage('resolving');
  const source = await resolvePaperSource(paper);
  if (!source.pdfUrl) {
    return { patch: { pdfStatus: 'unavailable', sourceUrl: source.landingUrl }, bytes: null };
  }

  const patch: Partial<Paper> = { pdfStatus: 'found', sourceUrl: source.pdfUrl };

  await setStage('fetching');
  const bytes = await fetchPdf(source.pdfUrl);
  if (!bytes) return { patch, bytes: null };

  const key = blobKey(profileId, paper.id, 'pdf');
  await blobs.put(key, bytes, 'application/pdf');
  patch.pdfKey = key;
  patch.pdfStatus = 'fetched';
  return { patch, bytes };
};

/**
 * Publishers such as PMC serve a bot-block page instead of the PDF, so many
 * papers can never be indexed from their full text. Indexing whatever prose we
 * do hold keeps chat grounded in something rather than nothing.
 */
const summaryDocument = (paper: Paper): string =>
  [
    `Title: ${paper.title}`,
    `Authors: ${(paper.authors ?? []).join(', ')}`,
    `Year: ${paper.year ?? ''}`,
    '',
    paper.summary ?? '',
    '',
    paper.blogContent ?? '',
    '',
    ...(paper.slides ?? []).map(s => `${s.title}: ${s.points.join(' ')}`),
  ]
    .join('\n')
    .trim();

/** Fetches the full text if it can, and indexes the best text available either way. */
const runIndex = async (
  profileId: string,
  paper: Paper,
  blobs: BlobStore,
  storeName: string,
  setStage: (stage: Paper['stage']) => Promise<void>
): Promise<Partial<Paper>> => {
  const { patch, bytes } = await acquirePdf(profileId, paper, blobs, setStage);

  await setStage('indexing');
  const metadata = {
    paperId: paper.id,
    title: paper.title,
    year: paper.year ?? '',
    authors: (paper.authors ?? []).join(', '),
  };

  const docName = bytes
    ? await indexDocument(storeName, bytes, 'application/pdf', paper.title, metadata)
    : await indexDocument(storeName, Buffer.from(summaryDocument(paper), 'utf8'), 'text/plain', paper.title, {
        ...metadata,
        kind: 'generated-summary',
      });

  if (!docName) return { ...patch, indexStatus: 'error' };

  // Re-indexing replaces the previous document rather than accumulating
  // duplicates, so a summary-indexed paper upgrades cleanly to its full text.
  if (paper.fileSearchDocName && paper.fileSearchDocName !== docName) {
    await deleteDocument(paper.fileSearchDocName);
  }

  return {
    ...patch,
    fileSearchDocName: docName,
    indexStatus: 'indexed',
    indexedKind: bytes ? 'pdf' : 'summary',
  };
};

/** Writes the blog, slides, quiz and flashcards, then the audio and illustration. */
const runArtifacts = async (
  profileId: string,
  paper: Paper,
  blobs: BlobStore,
  storeName: string | undefined,
  setStage: (stage: Paper['stage']) => Promise<void>
): Promise<Partial<Paper>> => {
  const patch: Partial<Paper> = {};

  // Without an indexed full text, generation grounds on the paper's own URL, so
  // resolving the source first materially improves what gets written.
  if (!paper.fileSearchDocName && !paper.sourceUrl) {
    await setStage('resolving');
    const source = await resolvePaperSource(paper).catch(() => null);
    if (source) patch.sourceUrl = source.pdfUrl || source.landingUrl;
  }

  await setStage('writing');
  const resources = await generatePaperResources(paper, {
    storeName,
    sourceUrl: patch.sourceUrl ?? paper.sourceUrl,
  });
  Object.assign(patch, resources);

  await setStage('media');
  const [audio, illustration] = await Promise.all([
    resources.audioScript ? generateAudio(resources.audioScript) : Promise.resolve(undefined),
    generateIllustration(paper.title, paper.summary),
  ]);

  if (audio) {
    const key = blobKey(profileId, paper.id, 'audio');
    await blobs.put(key, audio.data, audio.mime);
    patch.audioKey = key;
    patch.audioMime = audio.mime;
  }
  if (illustration) {
    const key = blobKey(profileId, paper.id, 'illustration');
    await blobs.put(key, illustration.data, illustration.mime);
    patch.illustrationKey = key;
    patch.illustrationMime = illustration.mime;
  }
  return patch;
};

export const processPaper = async (
  profileId: string,
  paper: Paper,
  blobs: BlobStore,
  storeName: string | undefined,
  mode: PipelineMode = 'both',
  onProgress?: ProgressFn
): Promise<Paper> => {
  const wantsIndex = mode !== 'artifacts';
  const wantsArtifacts = mode !== 'index';

  let current: Paper = {
    ...paper,
    // Each half owns its own status, so indexing a finished paper does not hide
    // its Read button and generating does not clear its Indexed badge.
    ...(wantsIndex ? { indexStatus: 'indexing' as const } : {}),
    ...(wantsArtifacts ? { status: 'processing' as const } : {}),
    stage: 'resolving',
  };

  const save = async () => {
    await repo.upsertPaper(profileId, current);
    try {
      await onProgress?.(current);
    } catch {
      // The client may have navigated away mid-run. Progress reporting is
      // best-effort: processing continues and Firestore stays authoritative.
    }
  };

  const setStage = async (stage: Paper['stage']) => {
    current = { ...current, stage };
    await save();
  };

  try {
    await save();

    if (wantsIndex) {
      if (!storeName) throw new Error('This profile has no File Search store.');
      // The patch is bound before the assignment: spreading `current` inline
      // would snapshot it ahead of the await and undo every setStage in between.
      const patch = await runIndex(profileId, current, blobs, storeName, setStage);
      current = { ...current, ...patch };
      await save();
    }

    if (wantsArtifacts) {
      const patch = await runArtifacts(profileId, current, blobs, storeName, setStage);
      current = { ...current, ...patch };
      current.status = 'converted';
      await save();

      // A paper indexed from its abstract alone gets re-indexed against the
      // write-up, which is far richer than the metadata it was holding.
      if (mode === 'both' && storeName && current.indexedKind === 'summary' && current.blogContent) {
        await setStage('indexing');
        const reindexed = await runIndex(profileId, current, blobs, storeName, setStage);
        current = { ...current, ...reindexed };
      }
    }

    current.stage = undefined;
    await save();
  } catch (error) {
    console.error(`Error processing paper ${current.title}:`, error);
    if (wantsIndex && current.indexStatus === 'indexing') current.indexStatus = 'error';
    if (wantsArtifacts) current.status = 'error';
    current.stage = undefined;
    await save();
  }
  return current;
};

/** Kept at 2 to stay inside the API's rate limits, as the client pool was. */
const CONCURRENCY_LIMIT = 2;

export const processPapers = async (
  profileId: string,
  papers: Paper[],
  blobs: BlobStore,
  storeName: string | undefined,
  mode: PipelineMode = 'both',
  onProgress?: ProgressFn
): Promise<void> => {
  const queue = [...papers];
  const worker = async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      await processPaper(profileId, next, blobs, storeName, mode, onProgress);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(papers.length, CONCURRENCY_LIMIT) }, () => worker())
  );
};
