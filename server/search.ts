import { Ctx, visibilityPredicate } from './authz';
import { many } from './db';
import { embedTexts, hasEmbeddings, vectorLiteral } from './indexer';

/**
 * Search across every library the caller can reach.
 *
 * The ACL predicate is a clause in the same query as the retrieval, which is the
 * whole reason the index lives here. There is no post-filtering step that could
 * be forgotten, and no cap on how many libraries one search may span.
 */

export interface Hit {
  chunkId: string;
  text: string;
  ordinal: number;
  paperId: string;
  paperTitle: string;
  profileId: string;
  profileTitle: string;
  /** Fused rank score; comparable within one result set only. */
  score: number;
  /** Which retrieval arm surfaced it, for diagnostics and for the UI. */
  matched: Array<'keyword' | 'semantic'>;
}

export type Scope = 'me' | 'team' | 'org' | 'profile';

interface Row {
  chunk_id: string;
  text: string;
  ordinal: number;
  paper_id: string;
  paper_title: string;
  profile_id: string;
  profile_title: string;
}

/**
 * Extra narrowing *inside* what the ACL already allows — never a widening.
 *
 * Returns the clause together with the value it needs, because a parameter that
 * the chosen scope does not reference must not be bound at all: Postgres rejects
 * a statement whose parameters go unused.
 */
const scopeClause = (
  scope: Scope,
  ctx: Ctx,
  placeholder: string
): { sql: string; value?: string } => {
  if (scope === 'me') return { sql: 'AND p.owner_id = $1' };
  if (scope === 'team') return { sql: `AND p.team_id = ${placeholder}`, value: ctx.teamId };
  if (scope === 'org') return { sql: `AND p.org_id = ${placeholder}`, value: ctx.orgId };
  return { sql: '' };
};

const BASE_JOIN = `
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN papers   pa ON pa.profile_id = d.profile_id AND pa.id = d.paper_id
    JOIN profiles p  ON p.id = d.profile_id`;

/**
 * The keyword query, built by OR-ing the question's lexemes and ranking.
 *
 * `websearch_to_tsquery` — the obvious choice, and what this used first — ANDs
 * every term. That is right for a search box and catastrophic for a question:
 * "what do you think about neural networks" requires a chunk containing *think*
 * as well, and no paper contains "think", so the whole thing matches nothing.
 * Every conversational question returned zero results and every advisor
 * abstained, which read as the feature being broken rather than the query being
 * wrong.
 *
 * OR-ing them and ranking gives what a search engine gives: chunks matching more
 * of the question rank higher, and one missing word does not eliminate a
 * passage. `ts_rank_cd` weights proximity, so terms appearing together beat the
 * same terms scattered.
 *
 * Lexemising the question with `to_tsvector` before rebuilding it also means no
 * raw user text reaches `to_tsquery`, where `&`, `|` and `!` would otherwise be
 * operators.
 */
const OR_QUERY = `
  to_tsquery(
    'english',
    array_to_string(tsvector_to_array(to_tsvector('english', $2)), ' | ')
  )`;

const SELECT_COLUMNS = `
    SELECT c.id AS chunk_id, c.text, c.ordinal,
           pa.id AS paper_id, pa.title AS paper_title,
           p.id AS profile_id, p.title AS profile_title`;

const keywordSearch = async (
  ctx: Ctx,
  q: string,
  scope: Scope,
  profileId: string | null,
  limit: number
): Promise<Row[]> => {
  const scoped = scopeClause(scope, ctx, '$5');
  const values: unknown[] = [ctx.userId, q, limit, profileId];
  if (scoped.value !== undefined) values.push(scoped.value);

  return many<Row>(
    `${SELECT_COLUMNS}
       ${BASE_JOIN},
            ${OR_QUERY} AS query
      WHERE c.tsv @@ query
        AND ($4::text IS NULL OR p.id = $4)
        AND ${visibilityPredicate('p', '$1', 'view')}
        ${scoped.sql}
      ORDER BY ts_rank_cd(c.tsv, query) DESC
      LIMIT $3`,
    values
  );
};

const semanticSearch = async (
  ctx: Ctx,
  vector: number[],
  scope: Scope,
  profileId: string | null,
  limit: number
): Promise<Row[]> => {
  const scoped = scopeClause(scope, ctx, '$5');
  const values: unknown[] = [ctx.userId, vectorLiteral(vector), limit, profileId];
  if (scoped.value !== undefined) values.push(scoped.value);

  return many<Row>(
    `${SELECT_COLUMNS}
       ${BASE_JOIN}
      WHERE c.embedding IS NOT NULL
        AND ($4::text IS NULL OR p.id = $4)
        AND ${visibilityPredicate('p', '$1', 'view')}
        ${scoped.sql}
      ORDER BY c.embedding <=> $2::vector
      LIMIT $3`,
    values
  );
};

/**
 * Reciprocal-rank fusion.
 *
 * Chosen over score normalisation because the two arms produce incomparable
 * numbers — `ts_rank_cd` is unbounded and corpus-dependent, cosine distance is
 * bounded — and RRF only ever compares an item to others in its own list. `k`
 * damps the influence of the very top of either list, so one arm being confident
 * cannot bury a result the other ranked highly.
 */
export const fuse = <T>(
  lists: Array<{ items: T[]; label: 'keyword' | 'semantic' }>,
  key: (item: T) => string,
  k = 60
): Array<{ item: T; score: number; matched: Array<'keyword' | 'semantic'> }> => {
  const seen = new Map<string, { item: T; score: number; matched: Array<'keyword' | 'semantic'> }>();

  for (const { items, label } of lists) {
    items.forEach((item, rank) => {
      const id = key(item);
      const contribution = 1 / (k + rank + 1);
      const existing = seen.get(id);
      if (existing) {
        existing.score += contribution;
        if (!existing.matched.includes(label)) existing.matched.push(label);
      } else {
        seen.set(id, { item, score: contribution, matched: [label] });
      }
    });
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
};

export interface SearchOptions {
  scope?: Scope;
  profileId?: string;
  limit?: number;
}

export const search = async (ctx: Ctx, q: string, options: SearchOptions = {}): Promise<Hit[]> => {
  const query = (q || '').trim();
  if (!query) return [];

  // A question made only of stopwords lexemises to nothing, which is a legitimate
  // no-match rather than an error — but there is no point asking the database.
  if (!/[a-z0-9]/i.test(query)) return [];

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const scope = options.scope ?? 'org';
  const profileId = options.profileId ?? null;
  // Over-fetch each arm so fusion has something to fuse.
  const perArm = limit * 3;

  const keyword = await keywordSearch(ctx, query, scope, profileId, perArm);

  // Semantic retrieval is additive. Without the embedding column, or with the
  // embedding call failing, search narrows to keyword rather than erroring —
  // the same degradation rule the ingest pipeline follows.
  let semantic: Row[] = [];
  if (await hasEmbeddings()) {
    const vectors = await embedTexts([query], 'RETRIEVAL_QUERY');
    if (vectors?.[0]) {
      semantic = await semanticSearch(ctx, vectors[0], scope, profileId, perArm).catch(() => []);
    }
  }

  const fused = fuse(
    [
      { items: keyword, label: 'keyword' as const },
      { items: semantic, label: 'semantic' as const },
    ],
    row => String(row.chunk_id)
  );

  return fused.slice(0, limit).map(({ item, score, matched }) => ({
    chunkId: String(item.chunk_id),
    text: item.text,
    ordinal: item.ordinal,
    paperId: item.paper_id,
    paperTitle: item.paper_title,
    profileId: item.profile_id,
    profileTitle: item.profile_title,
    score,
    matched,
  }));
};
