import { createHash } from 'node:crypto';
import { Paper } from '../types';
import { BlobStore } from './blobStore';
import * as repo from './repository';
import { CorpusRecord } from './repository';

/**
 * Papers are de-duplicated across profiles and owners.
 *
 * Retrieval itself cannot be shared: File Search scopes to whole stores, a
 * single call accepts fewer than ten of them, and metadata filtering only works
 * on the API's own recognised keys — an app-defined key silently matches
 * nothing (verified against the live API; see docs/architecture). So each
 * profile keeps its own store and its own embedding, which is what guarantees
 * one profile can never retrieve another's library.
 *
 * What *is* shared is everything before that: identifying the paper, resolving
 * an open-access URL, and downloading the PDF. That is the slow, flaky,
 * failure-prone majority of indexing, and it is identical for every profile
 * holding the same paper.
 */

/** Strips subtitles, punctuation and casing so near-identical titles collide. */
const normalizeTitle = (title: string): string =>
  (title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * A stable identity for a paper, computable from metadata alone — it has to be,
 * because the lookup happens *before* resolution, which is the step being
 * skipped. Title is the only field always present and always the same across
 * profiles; year and authors vary in formatting between search results.
 */
export const canonicalKey = (paper: Pick<Paper, 'title'>): string => {
  const normalized = normalizeTitle(paper.title);
  if (!normalized) return 'unknown';
  const slug = normalized.replace(/\s+/g, '-').slice(0, 60).replace(/-+$/, '');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  return `${slug}-${digest}`;
};

export interface CorpusHit {
  record: CorpusRecord;
  /** Cached PDF bytes, when the corpus holds them and they are still readable. */
  bytes: Buffer | null;
}

/** Where the shared cache keeps a paper's bytes. Never served to a browser. */
export const corpusBlobKey = (key: string): string => `corpus/${key}/pdf`;

/**
 * Looks a paper up in the shared corpus. A hit carrying bytes lets the caller
 * skip resolution and download entirely.
 */
export const lookup = async (
  paper: Pick<Paper, 'title'>,
  blobs: BlobStore
): Promise<CorpusHit | null> => {
  const key = canonicalKey(paper);
  const record = await repo.getCorpusRecord(key).catch(() => null);
  if (!record) return null;

  if (!record.pdfBlobKey) return { record, bytes: null };

  // The cache is advisory: a missing or unreadable blob degrades to a fresh
  // fetch rather than failing the index.
  const stored = await blobs.get(record.pdfBlobKey).catch(() => null);
  return { record, bytes: stored?.data ?? null };
};

/**
 * Records what resolution found, so the next profile does not repeat it —
 * including the negative case, where knowing no open-access PDF exists saves
 * the whole arXiv → Crossref → Unpaywall → search sequence.
 */
export const remember = async (
  paper: Pick<Paper, 'title'>,
  outcome: { bytes?: Buffer | null; sourceUrl?: string; pdfStatus?: Paper['pdfStatus'] },
  blobs: BlobStore
): Promise<string> => {
  const key = canonicalKey(paper);
  const now = Date.now();
  const existing = await repo.getCorpusRecord(key).catch(() => null);

  let pdfBlobKey = existing?.pdfBlobKey;
  if (outcome.bytes && !pdfBlobKey) {
    pdfBlobKey = corpusBlobKey(key);
    await blobs.put(pdfBlobKey, outcome.bytes, 'application/pdf').catch(() => {
      pdfBlobKey = undefined; // Caching is best-effort; indexing continues.
    });
  }

  await repo
    .putCorpusRecord({
      key,
      title: paper.title,
      pdfBlobKey,
      sourceUrl: outcome.sourceUrl ?? existing?.sourceUrl,
      pdfStatus: outcome.pdfStatus ?? existing?.pdfStatus,
      firstSeenAt: existing?.firstSeenAt ?? now,
      updatedAt: now,
    })
    .catch(() => {
      // A corpus write failing must never fail the paper being indexed.
    });

  return key;
};

export const noteReuse = (key: string): Promise<void> =>
  repo.noteCorpusReuse(key).catch(() => undefined);
