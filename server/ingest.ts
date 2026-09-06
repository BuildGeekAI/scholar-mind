import { Paper } from '../types';
import { BlobStore, blobKey } from './blobStore';
import { generateAudio, generateIllustration, generatePaperResources } from './gemini';
import { indexDocument } from './fileSearch';
import { fetchPdf, resolvePaperSource } from './paperSource';
import * as repo from './repository';

export type ProgressFn = (paper: Paper) => void | Promise<void>;

/**
 * Replaces the client's simulated download step. Ingestion failures degrade to
 * search-grounded generation rather than blocking: a missing PDF must never stop
 * a paper from producing content.
 */
const acquirePdf = async (
  profileId: string,
  paper: Paper,
  blobs: BlobStore,
  storeName: string | undefined,
  setStage: (stage: Paper['stage']) => Promise<void>
): Promise<Partial<Paper>> => {
  const source = await resolvePaperSource(paper);
  if (!source.pdfUrl) {
    return { pdfStatus: 'unavailable', sourceUrl: source.landingUrl };
  }

  const patch: Partial<Paper> = { pdfStatus: 'found', sourceUrl: source.pdfUrl };

  await setStage('fetching');
  const bytes = await fetchPdf(source.pdfUrl);
  if (!bytes) return patch;

  const key = blobKey(profileId, paper.id, 'pdf');
  await blobs.put(key, bytes, 'application/pdf');
  patch.pdfKey = key;
  patch.pdfStatus = 'fetched';

  if (storeName) {
    await setStage('indexing');
    const docName = await indexDocument(storeName, bytes, 'application/pdf', paper.title, {
      paperId: paper.id,
      title: paper.title,
      year: paper.year ?? '',
      authors: (paper.authors ?? []).join(', '),
    });
    if (docName) patch.fileSearchDocName = docName;
  }
  return patch;
};

export const processPaper = async (
  profileId: string,
  paper: Paper,
  blobs: BlobStore,
  storeName: string | undefined,
  onProgress?: ProgressFn
): Promise<Paper> => {
  let current: Paper = { ...paper, status: 'downloading', pdfStatus: 'pending', stage: 'resolving' };
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
    current = {
      ...current,
      ...(await acquirePdf(profileId, paper, blobs, storeName, setStage)),
    };
    current.status = 'processing';
    current.stage = 'writing';
    await save();

    const resources = await generatePaperResources(current, {
      storeName,
      sourceUrl: current.sourceUrl,
    });
    current = { ...current, ...resources };
    await save();

    current.stage = 'media';
    await save();

    const [audio, illustration] = await Promise.all([
      resources.audioScript ? generateAudio(resources.audioScript) : Promise.resolve(undefined),
      generateIllustration(current.title, current.summary),
    ]);

    if (audio) {
      const key = blobKey(profileId, current.id, 'audio');
      await blobs.put(key, audio.data, audio.mime);
      current.audioKey = key;
      current.audioMime = audio.mime;
    }
    if (illustration) {
      const key = blobKey(profileId, current.id, 'illustration');
      await blobs.put(key, illustration.data, illustration.mime);
      current.illustrationKey = key;
      current.illustrationMime = illustration.mime;
    }

    // Publishers such as PMC serve a bot-block page instead of the PDF, so
    // many papers never reach the index. Falling back to the generated
    // write-up keeps chat grounded in something rather than nothing.
    if (storeName && !current.fileSearchDocName && current.blogContent) {
      const fallback = [
        `Title: ${current.title}`,
        `Authors: ${(current.authors ?? []).join(', ')}`,
        `Year: ${current.year ?? ''}`,
        '',
        current.blogContent,
        '',
        ...(current.slides ?? []).map(s => `${s.title}: ${s.points.join(' ')}`),
      ].join('\n');
      const docName = await indexDocument(
        storeName,
        Buffer.from(fallback, 'utf8'),
        'text/plain',
        current.title,
        { paperId: current.id, title: current.title, kind: 'generated-summary' }
      );
      if (docName) current.fileSearchDocName = docName;
    }

    current.status = 'converted';
    current.stage = undefined;
    await save();
  } catch (error) {
    console.error(`Error processing paper ${current.title}:`, error);
    current.status = 'error';
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
  onProgress?: ProgressFn
): Promise<void> => {
  const queue = [...papers];
  const worker = async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      await processPaper(profileId, next, blobs, storeName, onProgress);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(papers.length, CONCURRENCY_LIMIT) }, () => worker())
  );
};
