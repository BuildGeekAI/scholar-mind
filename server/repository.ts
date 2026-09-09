import { Message, Paper } from '../types';
import { Access, Ctx, Visibility, visibilityPredicate } from './authz';
import { many, one, query, transaction } from './db';

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
  /** Set once the profile's File Search store exists. */
  fileSearchStoreName?: string;
  /**
   * Every identity this profile's scholar is known by — the URL it was built
   * from and the name that resolved to. Used to spot a second profile for a
   * scholar the user already has a library for.
   */
  scholarKeys?: string[];

  // --- Advisor -------------------------------------------------------------
  /** A profile becomes an advisor when this is set; everything else stays. */
  advisorEnabled?: boolean;
  advisorName?: string;
  advisorTitle?: string;
  /** Voice and stance only — never facts. See D2 in the advisors plan. */
  advisorBrief?: string;
  advisorAvatarKey?: string;
}

// --- Mapping ------------------------------------------------------------------
// Postgres speaks snake_case and timestamptz; the domain types speak camelCase
// and epoch milliseconds. One place for the translation, in both directions.

const ms = (value: Date | string | number | null): number =>
  value == null ? 0 : value instanceof Date ? value.getTime() : new Date(value).getTime();

const toProfile = (r: any): ProfileRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  orgId: r.org_id,
  teamId: r.team_id,
  visibility: r.visibility,
  title: r.title,
  emoji: r.emoji,
  theme: r.theme,
  createdAt: ms(r.created_at),
  updatedAt: ms(r.updated_at),
  scholarName: r.scholar_name ?? undefined,
  affiliation: r.affiliation ?? undefined,
  topics: r.topics ?? [],
  fileSearchStoreName: r.file_search_store_name ?? undefined,
  scholarKeys: r.scholar_keys ?? [],
  advisorEnabled: r.advisor_enabled ?? false,
  advisorName: r.advisor_name ?? undefined,
  advisorTitle: r.advisor_title ?? undefined,
  advisorBrief: r.advisor_brief ?? undefined,
  advisorAvatarKey: r.advisor_avatar_key ?? undefined,
});

/**
 * Column ↔ field, in one table, so the insert list, the update list and the
 * reader can never drift apart. `json` values are stringified; everything else
 * is passed through and `undefined` becomes SQL NULL.
 *
 * There is no equivalent of the old `withDeletions` here: Firestore's merge
 * writes could not clear a field, so transient pipeline state had to be deleted
 * explicitly. Setting a column to NULL simply works.
 */
const PAPER_COLUMNS: Array<[column: string, field: keyof Paper, json?: boolean]> = [
  ['kind', 'kind'],
  ['title', 'title'],
  ['year', 'year'],
  ['authors', 'authors'],
  ['summary', 'summary'],
  ['citation_count', 'citationCount'],
  ['status', 'status'],
  ['stage', 'stage'],
  ['pdf_status', 'pdfStatus'],
  ['index_status', 'indexStatus'],
  ['indexed_kind', 'indexedKind'],
  ['pdf_reused', 'pdfReused'],
  ['blog_title', 'blogTitle'],
  ['blog_content', 'blogContent'],
  ['audio_script', 'audioScript'],
  ['slides', 'slides', true],
  ['quiz', 'quiz', true],
  ['flash_cards', 'flashCards', true],
  ['citing_papers', 'citingPapers', true],
  ['citation_meta', 'citationMeta', true],
  ['illustration_key', 'illustrationKey'],
  ['illustration_mime', 'illustrationMime'],
  ['audio_key', 'audioKey'],
  ['audio_mime', 'audioMime'],
  ['pdf_key', 'pdfKey'],
  ['media_key', 'mediaKey'],
  ['media_mime', 'mediaMime'],
  ['file_name', 'fileName'],
  ['source_url', 'sourceUrl'],
  ['extracted_text', 'extractedText'],
  ['duration_seconds', 'durationSeconds'],
  ['file_search_doc_name', 'fileSearchDocName'],
];

const toPaper = (r: any): Paper => {
  const paper: any = { id: r.id };
  for (const [column, field] of PAPER_COLUMNS) {
    const value = r[column];
    if (value !== null && value !== undefined) paper[field] = value;
  }
  paper.authors = r.authors ?? [];
  paper.title = r.title;
  paper.status = r.status;
  return paper as Paper;
};

const paperValues = (paper: Paper): unknown[] =>
  PAPER_COLUMNS.map(([column, field, json]) => {
    const value = (paper as any)[field];
    if (value === undefined || value === null) {
      // Three columns are NOT NULL; the rest are genuinely absent.
      if (column === 'status') return 'discovered';
      if (column === 'kind') return 'paper';
      if (column === 'pdf_reused') return false;
      if (column === 'authors') return [];
      return null;
    }
    return json ? JSON.stringify(value) : value;
  });

// --- Profiles -----------------------------------------------------------------

// Split so a caller can append a computed column without restating the list.
const PROFILE_COLUMNS = `
  p.id, p.owner_id, p.org_id, p.team_id, p.visibility, p.title, p.emoji,
  p.theme, p.created_at, p.updated_at, p.scholar_name, p.affiliation,
  p.topics, p.file_search_store_name, p.scholar_keys,
  p.advisor_enabled, p.advisor_name, p.advisor_title, p.advisor_brief,
  p.advisor_avatar_key`;

const PROFILE_SELECT = `SELECT ${PROFILE_COLUMNS} FROM profiles p`;

export const listProfiles = async (ctx: Ctx): Promise<ProfileRecord[]> =>
  (
    await many(
      `${PROFILE_SELECT} WHERE ${visibilityPredicate('p', '$1', 'view')}
       ORDER BY p.updated_at DESC`,
      [ctx.userId]
    )
  ).map(toProfile);

/**
 * Loads a profile only if the caller may reach it at the requested level.
 * `access` defaults to 'view'; write endpoints ask for 'edit', and destructive
 * ones for 'own', because ownership is not grantable.
 */
export const getProfile = async (
  ctx: Ctx,
  id: string,
  access: Access = 'view'
): Promise<ProfileRecord | null> => {
  const row = await one(
    `${PROFILE_SELECT} WHERE p.id = $2 AND ${visibilityPredicate('p', '$1', access)}`,
    [ctx.userId, id]
  );
  return row ? toProfile(row) : null;
};

export const createProfile = async (
  ctx: Ctx,
  partial: Partial<ProfileRecord> & { id: string }
): Promise<ProfileRecord> => {
  const row = await one(
    `INSERT INTO profiles (id, org_id, team_id, owner_id, visibility, title, emoji,
                           theme, scholar_name, affiliation, topics, scholar_keys,
                           advisor_enabled, advisor_name, advisor_title, advisor_brief)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      partial.id,
      partial.orgId ?? ctx.orgId,
      partial.teamId ?? ctx.teamId,
      ctx.userId,
      partial.visibility ?? 'org',
      partial.title ?? 'Untitled profile',
      partial.emoji ?? '📒',
      partial.theme ?? 'Ocean',
      partial.scholarName ?? null,
      partial.affiliation ?? null,
      partial.topics ?? [],
      partial.scholarKeys ?? [],
      // Accepted here as well as on the advisor endpoint: taking a field in a
      // Partial<ProfileRecord> and quietly dropping it is worse than refusing it.
      partial.advisorEnabled ?? false,
      partial.advisorName ?? null,
      partial.advisorTitle ?? null,
      partial.advisorBrief ?? null,
    ]
  );
  return toProfile(row);
};

const UPDATABLE: Array<[column: string, field: keyof ProfileRecord]> = [
  ['title', 'title'],
  ['emoji', 'emoji'],
  ['theme', 'theme'],
  ['visibility', 'visibility'],
  ['scholar_name', 'scholarName'],
  ['affiliation', 'affiliation'],
  ['topics', 'topics'],
  ['file_search_store_name', 'fileSearchStoreName'],
  ['scholar_keys', 'scholarKeys'],
  ['advisor_enabled', 'advisorEnabled'],
  ['advisor_name', 'advisorName'],
  ['advisor_title', 'advisorTitle'],
  ['advisor_brief', 'advisorBrief'],
  ['advisor_avatar_key', 'advisorAvatarKey'],
];

export const updateProfile = async (
  ctx: Ctx,
  id: string,
  patch: Partial<ProfileRecord>
): Promise<ProfileRecord | null> => {
  // Only the named columns move; id, org, team and owner are never patchable
  // from a request body.
  const sets: string[] = [];
  const values: unknown[] = [ctx.userId, id];
  for (const [column, field] of UPDATABLE) {
    if (patch[field] === undefined) continue;
    values.push(patch[field]);
    sets.push(`${column} = $${values.length}`);
  }
  sets.push('updated_at = now()');

  const row = await one(
    `UPDATE profiles p SET ${sets.join(', ')}
      WHERE p.id = $2 AND ${visibilityPredicate('p', '$1', 'edit')}
      RETURNING *`,
    values
  );
  return row ? toProfile(row) : null;
};

/** Papers and messages go with it: the foreign keys cascade, so there is no
 *  batched collection sweep any more. */
export const deleteProfile = async (ctx: Ctx, id: string): Promise<boolean> => {
  const row = await one(
    `DELETE FROM profiles p
      WHERE p.id = $2 AND ${visibilityPredicate('p', '$1', 'own')}
      RETURNING p.id`,
    [ctx.userId, id]
  );
  return !!row;
};

/**
 * Profiles whose scholar identity collides with any of `keys`, within the
 * caller's reach. Checked before a search writes anything, so a rejected search
 * leaves nothing behind.
 */
export const findByScholarKeys = async (ctx: Ctx, keys: string[]): Promise<ProfileRecord[]> => {
  if (!keys.length) return [];
  return (
    await many(
      `${PROFILE_SELECT}
        WHERE p.scholar_keys && $2::text[]
          AND ${visibilityPredicate('p', '$1', 'view')}`,
      [ctx.userId, keys]
    )
  ).map(toProfile);
};

export interface AdvisorSummary extends ProfileRecord {
  /** Papers actually in the search index. An advisor with none knows nothing. */
  indexedCount: number;
  /** Whether the caller owns this advisor or is consulting someone else's. */
  mine: boolean;
}

/**
 * Every advisor the caller can see — their own and any shared with them.
 *
 * The indexed count comes from `documents`, not from the papers table: a paper
 * that has not been indexed cannot be retrieved, so counting papers would
 * promise knowledge the advisor does not have.
 */
export const listAdvisors = async (ctx: Ctx): Promise<AdvisorSummary[]> =>
  (
    await many(
      `SELECT ${PROFILE_COLUMNS},
              (SELECT count(*) FROM documents d WHERE d.profile_id = p.id) AS indexed_count
         FROM profiles p
        WHERE p.advisor_enabled
          AND ${visibilityPredicate('p', '$1', 'view')}
        ORDER BY p.updated_at DESC`,
      [ctx.userId]
    )
  ).map(r => ({
    ...toProfile(r),
    indexedCount: Number(r.indexed_count ?? 0),
    mine: r.owner_id === ctx.userId,
  }));

// --- Consultations ------------------------------------------------------------

export interface ConsultationAnswer {
  profileId: string;
  advisorName: string;
  answer: string;
  citations: unknown[];
  /** True when the advisor could not be reached at read time — see below. */
  hidden?: boolean;
}

export interface Consultation {
  id: string;
  question: string;
  synthesis?: string;
  createdAt: number;
  answers: ConsultationAnswer[];
}

export const saveConsultation = async (
  ctx: Ctx,
  question: string,
  answers: Array<{ profileId: string; advisorName: string; answer: string; citations: unknown[] }>,
  synthesis?: string
): Promise<string> =>
  transaction(async tx => {
    const { rows } = await tx.query(
      `INSERT INTO consultations (org_id, team_id, owner_id, question, synthesis)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ctx.orgId, ctx.teamId, ctx.userId, question, synthesis ?? null]
    );
    const id = rows[0].id;
    for (let i = 0; i < answers.length; i += 1) {
      const a = answers[i];
      await tx.query(
        `INSERT INTO consultation_answers
           (consultation_id, profile_id, advisor_name, answer, citations, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, a.profileId, a.advisorName, a.answer, JSON.stringify(a.citations ?? []), i]
      );
    }
    return id as string;
  });

export const listConsultations = async (ctx: Ctx): Promise<Consultation[]> =>
  (
    await many(
      `SELECT c.id, c.question, c.synthesis, c.created_at,
              count(a.id) AS answers
         FROM consultations c
         LEFT JOIN consultation_answers a ON a.consultation_id = c.id
        WHERE c.owner_id = $1
        GROUP BY c.id
        ORDER BY c.created_at DESC
        LIMIT 50`,
      [ctx.userId]
    )
  ).map(r => ({
    id: r.id,
    question: r.question,
    synthesis: r.synthesis ?? undefined,
    createdAt: ms(r.created_at),
    answers: [],
  }));

/**
 * One consultation, with each answer re-checked against the advisor's current
 * visibility.
 *
 * Sharing can be revoked after the fact. A stored answer must not become a way
 * to keep reading an advisor the owner has since taken back — so the visibility
 * predicate is applied at read time, not only at consultation time.
 */
export const getConsultation = async (ctx: Ctx, id: string): Promise<Consultation | null> => {
  const head = await one(
    `SELECT id, question, synthesis, created_at FROM consultations
      WHERE id = $1 AND owner_id = $2`,
    [id, ctx.userId]
  );
  if (!head) return null;

  const rows = await many(
    `SELECT a.profile_id, a.advisor_name, a.answer, a.citations,
            (p.id IS NOT NULL) AS visible
       FROM consultation_answers a
       LEFT JOIN profiles p
              ON p.id = a.profile_id
             AND ${visibilityPredicate('p', '$2', 'view')}
      WHERE a.consultation_id = $1
      ORDER BY a.ordinal`,
    [id, ctx.userId]
  );

  return {
    id: head.id,
    question: head.question,
    synthesis: head.synthesis ?? undefined,
    createdAt: ms(head.created_at),
    answers: rows.map(r =>
      r.visible
        ? {
            profileId: r.profile_id,
            advisorName: r.advisor_name,
            answer: r.answer,
            citations: r.citations ?? [],
          }
        : {
            profileId: r.profile_id,
            advisorName: r.advisor_name,
            answer: 'This advisor is no longer shared with you.',
            citations: [],
            hidden: true,
          }
    ),
  };
};

// --- Shared corpus ------------------------------------------------------------
/**
 * One record per canonical paper, across every profile, team and org. It caches
 * the expensive and unreliable half of indexing — source resolution and the PDF
 * download — so the second profile to index a paper never repeats them.
 *
 * Deliberately untenanted: it holds only public open-access content and nothing
 * profile-specific, and partitioning it per org would delete the reuse it
 * exists for.
 */
export interface CorpusRecord {
  key: string;
  title: string;
  pdfBlobKey?: string;
  sourceUrl?: string;
  pdfStatus?: Paper['pdfStatus'];
  firstSeenAt: number;
  updatedAt: number;
  reuseCount?: number;
}

const toCorpus = (r: any): CorpusRecord => ({
  key: r.key,
  title: r.title,
  pdfBlobKey: r.pdf_blob_key ?? undefined,
  sourceUrl: r.source_url ?? undefined,
  pdfStatus: r.pdf_status ?? undefined,
  firstSeenAt: Number(r.first_seen_at),
  updatedAt: Number(r.updated_at),
  reuseCount: r.reuse_count ?? 0,
});

export const getCorpusRecord = async (key: string): Promise<CorpusRecord | null> => {
  const row = await one(`SELECT * FROM corpus WHERE key = $1`, [key]);
  return row ? toCorpus(row) : null;
};

export const putCorpusRecord = async (record: CorpusRecord): Promise<void> => {
  await query(
    `INSERT INTO corpus (key, title, pdf_blob_key, source_url, pdf_status,
                         first_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (key) DO UPDATE SET
       title        = EXCLUDED.title,
       -- COALESCE, not EXCLUDED: a later write that resolved nothing must not
       -- erase bytes an earlier one cached.
       pdf_blob_key = COALESCE(EXCLUDED.pdf_blob_key, corpus.pdf_blob_key),
       source_url   = COALESCE(EXCLUDED.source_url,   corpus.source_url),
       pdf_status   = COALESCE(EXCLUDED.pdf_status,   corpus.pdf_status),
       updated_at   = EXCLUDED.updated_at`,
    [
      record.key,
      record.title,
      record.pdfBlobKey ?? null,
      record.sourceUrl ?? null,
      record.pdfStatus ?? null,
      record.firstSeenAt,
      record.updatedAt,
    ]
  );
};

/** Atomic so concurrent workers indexing the same paper cannot lose counts. */
export const noteCorpusReuse = async (key: string): Promise<void> => {
  await query(
    `UPDATE corpus SET reuse_count = reuse_count + 1, updated_at = $2 WHERE key = $1`,
    [key, Date.now()]
  );
};

export const listCorpus = async (): Promise<CorpusRecord[]> =>
  (await many(`SELECT * FROM corpus`)).map(toCorpus);

// --- Papers -------------------------------------------------------------------

export const listPapers = async (profileId: string): Promise<Paper[]> =>
  (
    await many(`SELECT * FROM papers WHERE profile_id = $1 ORDER BY created_at`, [profileId])
  ).map(toPaper);

export const getPaper = async (profileId: string, paperId: string): Promise<Paper | null> => {
  const row = await one(`SELECT * FROM papers WHERE profile_id = $1 AND id = $2`, [
    profileId,
    paperId,
  ]);
  return row ? toPaper(row) : null;
};

const columns = PAPER_COLUMNS.map(([c]) => c);
const upsertSql = `
  INSERT INTO papers (profile_id, id, ${columns.join(', ')})
  VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')})
  ON CONFLICT (profile_id, id) DO UPDATE SET
    ${columns.map(c => `${c} = EXCLUDED.${c}`).join(',\n    ')},
    updated_at = now()`;

export const upsertPaper = async (profileId: string, paper: Paper): Promise<void> => {
  await query(upsertSql, [profileId, paper.id, ...paperValues(paper)]);
};

export const upsertPapers = async (profileId: string, papers: Paper[]): Promise<void> => {
  if (!papers.length) return;
  // One statement per paper inside one transaction: the volume here is a
  // scholar's publication list, not a bulk load.
  for (const paper of papers) await upsertPaper(profileId, paper);
};

export const deletePaper = async (profileId: string, paperId: string): Promise<void> => {
  await query(`DELETE FROM papers WHERE profile_id = $1 AND id = $2`, [profileId, paperId]);
};

// --- Messages -----------------------------------------------------------------

const toMessage = (r: any): Message => ({
  id: r.id,
  role: r.role,
  content: r.content,
  timestamp: Number(r.timestamp),
  citations: r.citations ?? undefined,
});

export const listMessages = async (profileId: string): Promise<Message[]> =>
  (
    await many(`SELECT * FROM messages WHERE profile_id = $1 ORDER BY timestamp`, [profileId])
  ).map(toMessage);

export const appendMessage = async (profileId: string, message: Message): Promise<void> => {
  await query(
    `INSERT INTO messages (profile_id, id, role, content, citations, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (profile_id, id) DO UPDATE SET
       content = EXCLUDED.content, citations = EXCLUDED.citations`,
    [
      profileId,
      message.id,
      message.role,
      message.content,
      message.citations ? JSON.stringify(message.citations) : null,
      message.timestamp,
    ]
  );
};

export const clearMessages = async (profileId: string): Promise<void> => {
  await query(`DELETE FROM messages WHERE profile_id = $1`, [profileId]);
};
