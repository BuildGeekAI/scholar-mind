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
  storeName?: string
): Promise<Partial<Paper>> => {
  const source = await resolvePaperSource(paper);
  if (!source.pdfUrl) {
    return { pdfStatus: 'unavailable', sourceUrl: source.landingUrl };
  }

  const patch: Partial<Paper> = { pdfStatus: 'found', sourceUrl: source.pdfUrl };

  const bytes = await fetchPdf(source.pdfUrl);
  if (!bytes) return patch;

  const key = blobKey(profileId, paper.id, 'pdf');
  await blobs.put(key, bytes, 'application/pdf');
  patch.pdfKey = key;
  patch.pdfStatus = 'fetched';

  if (storeName) {
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
  let current: Paper = { ...paper, status: 'downloading', pdfStatus: 'pending' };
  const save = async () => {
    await repo.upsertPaper(profileId, current);
    await onProgress?.(current);
  };
  await save();

  try {
    current = { ...current, ...(await acquirePdf(profileId, paper, blobs, storeName)) };
    current.status = 'processing';
    await save();

    const resources = await generatePaperResources(current, {
      storeName,
      sourceUrl: current.sourceUrl,
    });
    current = { ...current, ...resources };
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

    current.status = 'converted';
    await save();
  } catch (error) {
    console.error(`Error processing paper ${current.title}:`, error);
    current.status = 'error';
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
