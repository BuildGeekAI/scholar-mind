import { Paper } from '../types';
import { one, query, transaction } from './db';
import { MODELS, ai } from './gemini';
import { indexableText } from './sources';

/**
 * Writes a paper into the Postgres reverse index.
 *
 * Chunks rather than whole documents, because a citation should point at the
 * passage supporting the claim. That also fixes something File Search could not:
 * with retrieval here, we know exactly which chunks were handed to the model, so
 * a citation is a fact about our own query rather than something the model
 * reported — which is the standing rule for citations in this codebase.
 */

/** Roughly 4 characters per token; the budget is a target, not a guarantee. */
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS || 1600);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 200);

/**
 * Splits on paragraph boundaries where it can and mid-paragraph only when a
 * paragraph is itself over budget. Overlap carries the tail of each chunk into
 * the next, so a claim spanning a boundary is still retrievable whole.
 */
export const chunkText = (
  text: string,
  size = CHUNK_CHARS,
  overlap = CHUNK_OVERLAP
): string[] => {
  const clean = (text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  /**
   * Overlap is clamped to half a chunk. Left unbounded — a misconfigured
   * CHUNK_OVERLAP, or a caller passing the two the wrong way round — each step
   * advances by a single character instead of most of a chunk, and the text is
   * emitted roughly once per character. It terminates, so nothing hangs; it just
   * multiplies the index and the embedding bill by three orders of magnitude,
   * which is the kind of failure that shows up on an invoice rather than in a log.
   */
  const step = Math.max(0, Math.min(overlap, Math.floor(size / 2)));

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < clean.length) {
    let end = Math.min(cursor + size, clean.length);

    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence end, then any whitespace.
      // The whitespace fallback matters: without it a chunk ends mid-word and
      // the next begins mid-word, so the split token matches nothing in either
      // half — it degrades the keyword index and the embedding alike.
      const window = clean.slice(cursor, end);
      const paragraph = window.lastIndexOf('\n\n');
      const sentence = window.lastIndexOf('. ');
      const space = window.lastIndexOf(' ');
      const cut =
        paragraph > size * 0.5
          ? paragraph + 2
          : sentence > size * 0.5
            ? sentence + 2
            : space > size * 0.5
              ? space + 1
              : -1;
      if (cut > 0) end = cursor + cut;
    }

    const piece = clean.slice(cursor, end).trim();
    if (piece) chunks.push(piece);

    if (end >= clean.length) break;
    // Never move backwards, or an over-long chunk loops forever.
    cursor = Math.max(end - step, cursor + 1);
  }

  return chunks;
};

/** Everything worth indexing about a paper, in the order a reader would meet it. */
export const documentBody = (paper: Paper): string => {
  const isPaper = (paper.kind ?? 'paper') === 'paper';
  if (!isPaper) return indexableText(paper);
  return [
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
};

// --- Embeddings ---------------------------------------------------------------

/**
 * Present only once `0004_embeddings.sql` has been applied, which needs the
 * model's output dimension measured first. Until then the index is keyword-only
 * and search degrades to FTS — the established pattern in this codebase, where a
 * missing capability narrows results rather than failing the request.
 */
let embeddingsAvailable: boolean | undefined;

export const hasEmbeddings = async (): Promise<boolean> => {
  if (embeddingsAvailable === undefined) {
    const row = await one(
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name = 'embedding'`
    ).catch(() => null);
    embeddingsAvailable = !!row;
  }
  return embeddingsAvailable;
};

const EMBED_BATCH = 32;

/**
 * Returns one vector per text, or null if embedding is unavailable. Never
 * throws: an index without vectors is still fully searchable by keyword.
 */
export const embedTexts = async (
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT'
): Promise<number[][] | null> => {
  if (!texts.length) return [];
  try {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const response: any = await (ai().models as any).embedContent({
        model: MODELS.embedding,
        contents: batch,
        config: { taskType },
      });
      const vectors: number[][] = (response?.embeddings ?? []).map((e: any) => e.values ?? e);
      if (vectors.length !== batch.length) throw new Error('embedding count mismatch');
      out.push(...vectors);
    }
    return out;
  } catch (e) {
    console.error('Embedding failed; falling back to keyword-only indexing:', e);
    return null;
  }
};

/** pgvector's text input format. */
const vectorLiteral = (values: number[]): string => `[${values.join(',')}]`;

// --- Writing ------------------------------------------------------------------

export interface IndexResult {
  documentId: string;
  chunks: number;
  embedded: boolean;
}

/**
 * Replaces whatever was indexed for this paper. One transaction, so a partially
 * re-indexed paper is never visible to a search running concurrently.
 */
export const indexPaper = async (
  profileId: string,
  paper: Paper,
  bodyKind: 'pdf' | 'summary' = 'summary',
  body?: string
): Promise<IndexResult | null> => {
  const text = body ?? documentBody(paper);
  const pieces = chunkText(text);
  if (!pieces.length) return null;

  const vectors = (await hasEmbeddings()) ? await embedTexts(pieces) : null;

  return transaction(async tx => {
    const { rows } = await tx.query(
      `INSERT INTO documents (profile_id, paper_id, source_kind, title, body_kind)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (profile_id, paper_id) DO UPDATE SET
         title = EXCLUDED.title, source_kind = EXCLUDED.source_kind,
         body_kind = EXCLUDED.body_kind, updated_at = now()
       RETURNING id`,
      [profileId, paper.id, paper.kind ?? 'paper', paper.title, bodyKind]
    );
    const documentId = rows[0].id;

    await tx.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);

    for (let i = 0; i < pieces.length; i += 1) {
      if (vectors) {
        await tx.query(
          `INSERT INTO chunks (document_id, ordinal, text, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [documentId, i, pieces[i], vectorLiteral(vectors[i])]
        );
      } else {
        await tx.query(`INSERT INTO chunks (document_id, ordinal, text) VALUES ($1, $2, $3)`, [
          documentId,
          i,
          pieces[i],
        ]);
      }
    }

    return { documentId, chunks: pieces.length, embedded: !!vectors };
  });
};

export const removePaperFromIndex = async (profileId: string, paperId: string): Promise<void> => {
  await query(`DELETE FROM documents WHERE profile_id = $1 AND paper_id = $2`, [profileId, paperId]);
};

export const indexedCount = async (profileId: string): Promise<number> => {
  const row = await one<{ n: string }>(
    `SELECT count(*) AS n FROM documents WHERE profile_id = $1`,
    [profileId]
  );
  return Number(row?.n ?? 0);
};

export { vectorLiteral };
