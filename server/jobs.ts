import { Ctx } from './authz';
import { Queryable, many, one, query } from './db';

/**
 * A durable work queue in the same database as the data it operates on.
 *
 * Two properties matter and neither is available from an external queue:
 * enqueueing happens inside the transaction that wrote the row being processed,
 * so there is no dual-write to reconcile; and the job row *is* the status the
 * client polls, so there is no second store to keep in sync.
 */

/**
 * Acquisition is not its own job type. `acquirePdf` is an internal step of
 * `runIndex`, and prising it out would mean restructuring the ingest pipeline
 * for no user-visible gain — the download's progress is already reported
 * separately, through the paper's own `pdfStatus`.
 */
export type JobType =
  | 'crawl.profile'
  | 'paper.index'
  | 'paper.enrich'
  | 'paper.process'
  | 'crawler.tick';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface Job {
  id: string;
  runId?: string;
  parentJobId?: string;
  orgId: string;
  teamId: string;
  ownerId: string;
  type: JobType;
  payload: Record<string, any>;
  dedupeKey?: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const toJob = (r: any): Job => ({
  id: r.id,
  runId: r.run_id ?? undefined,
  parentJobId: r.parent_job_id ?? undefined,
  orgId: r.org_id,
  teamId: r.team_id,
  ownerId: r.owner_id,
  type: r.type,
  payload: r.payload ?? {},
  dedupeKey: r.dedupe_key ?? undefined,
  status: r.status,
  priority: r.priority,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  error: r.error ?? undefined,
  createdAt: new Date(r.created_at).getTime(),
  updatedAt: new Date(r.updated_at).getTime(),
});

// --- Retry policy, as a pure function ----------------------------------------

/**
 * Exponential with a ceiling. Deliberately not jittered per-attempt here: the
 * jitter that matters is already supplied by workers claiming at different
 * moments, and a deterministic schedule is one that can be asserted in a test.
 */
export const backoffSeconds = (attempts: number): number =>
  Math.min(30 * 2 ** Math.max(0, attempts - 1), 15 * 60);

/** A job that has used its last attempt is dead, not merely failed. */
export const nextStatusAfterFailure = (attempts: number, maxAttempts: number): JobStatus =>
  attempts >= maxAttempts ? 'dead' : 'queued';

// --- Enqueue ------------------------------------------------------------------

export interface NewJob {
  type: JobType;
  payload?: Record<string, any>;
  runId?: string;
  parentJobId?: string;
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  /** Seconds to wait before the job becomes claimable. */
  delaySeconds?: number;
}

/**
 * Pass `tx` to enqueue inside a caller's transaction — the whole point of a
 * database-backed queue. Without it the insert is its own transaction.
 *
 * Returns null when the dedupe key collides with work already queued or
 * running: asking twice for the same paper is idempotent, not an error.
 */
export const enqueue = async (
  ctx: Ctx,
  job: NewJob,
  tx?: Queryable
): Promise<Job | null> => {
  const sql = `
    INSERT INTO jobs (run_id, parent_job_id, org_id, team_id, owner_id, type,
                      payload, dedupe_key, priority, max_attempts, run_after)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11))
    ON CONFLICT DO NOTHING
    RETURNING *`;
  const values = [
    job.runId ?? null,
    job.parentJobId ?? null,
    ctx.orgId,
    ctx.teamId,
    ctx.userId,
    job.type,
    JSON.stringify(job.payload ?? {}),
    job.dedupeKey ?? null,
    job.priority ?? 0,
    job.maxAttempts ?? 3,
    job.delaySeconds ?? 0,
  ];
  const rows = tx ? (await tx.query(sql, values)).rows : (await query(sql, values)).rows;
  return rows[0] ? toJob(rows[0]) : null;
};

// --- Claim --------------------------------------------------------------------

/**
 * Claims up to `limit` jobs for `workerId`.
 *
 * SKIP LOCKED is what makes this safe to run from as many workers as you like:
 * a row already locked by another claimer is passed over rather than waited on,
 * so two workers never take the same job and neither blocks the other.
 */
export const claim = async (workerId: string, limit = 1): Promise<Job[]> =>
  (
    await many(
      `UPDATE jobs SET status = 'running',
                       locked_by = $1,
                       locked_at = now(),
                       heartbeat_at = now(),
                       attempts = attempts + 1,
                       updated_at = now()
        WHERE id IN (
          SELECT id FROM jobs
           WHERE status = 'queued' AND run_after <= now()
           ORDER BY priority DESC, run_after
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING *`,
      [workerId, limit]
    )
  ).map(toJob);

export const heartbeat = async (jobId: string): Promise<void> => {
  await query(`UPDATE jobs SET heartbeat_at = now() WHERE id = $1`, [jobId]);
};

export const succeed = async (jobId: string, detail?: Record<string, any>): Promise<void> => {
  await query(
    `UPDATE jobs SET status = 'succeeded', error = NULL, locked_by = NULL,
                     updated_at = now()
      WHERE id = $1`,
    [jobId]
  );
  await note(jobId, 'succeeded', detail);
};

/** Requeues with backoff, or dead-letters once the attempts are spent. */
export const fail = async (job: Job, error: unknown): Promise<JobStatus> => {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const status = nextStatusAfterFailure(job.attempts, job.maxAttempts);
  const delay = status === 'queued' ? backoffSeconds(job.attempts) : 0;

  await query(
    `UPDATE jobs SET status = $2, error = $3, locked_by = NULL,
                     run_after = now() + make_interval(secs => $4),
                     updated_at = now()
      WHERE id = $1`,
    [job.id, status, message, delay]
  );
  await note(job.id, status, { error: message, attempt: job.attempts, retryInSeconds: delay });
  return status;
};

/**
 * Returns jobs whose worker stopped heartbeating to the queue. A process killed
 * mid-job — a Cloud Run instance scaled to zero, a crash — leaves its rows
 * 'running' forever otherwise.
 */
export const reapStale = async (staleSeconds = 120): Promise<number> => {
  const rows = await many(
    `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead'::job_status
                                   ELSE 'queued'::job_status END,
                     locked_by = NULL,
                     error = 'Worker stopped responding',
                     updated_at = now()
      WHERE status = 'running'
        AND heartbeat_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [staleSeconds]
  );
  return rows.length;
};

export const note = async (
  jobId: string,
  status: string,
  detail?: Record<string, any>
): Promise<void> => {
  await query(`INSERT INTO job_events (job_id, status, detail) VALUES ($1, $2, $3)`, [
    jobId,
    status,
    JSON.stringify(detail ?? {}),
  ]).catch(() => {
    // The timeline is diagnostic. Losing an event must never fail the work.
  });
};

// --- Runs ---------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  profileId: string;
  crawlerId?: string;
  kind: string;
  status: RunStatus;
  detail: Record<string, any>;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
}

const toRun = (r: any): Run => ({
  id: r.id,
  profileId: r.profile_id,
  crawlerId: r.crawler_id ?? undefined,
  kind: r.kind,
  status: r.status,
  detail: r.detail ?? {},
  error: r.error ?? undefined,
  startedAt: r.started_at ? new Date(r.started_at).getTime() : undefined,
  finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : undefined,
  createdAt: new Date(r.created_at).getTime(),
});

export const createRun = async (
  ctx: Ctx,
  profileId: string,
  kind: string,
  detail: Record<string, any> = {},
  crawlerId?: string,
  tx?: Queryable
): Promise<Run> => {
  const sql = `
    INSERT INTO crawl_runs (crawler_id, profile_id, org_id, team_id, triggered_by, kind, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`;
  const values = [
    crawlerId ?? null,
    profileId,
    ctx.orgId,
    ctx.teamId,
    ctx.userId,
    kind,
    JSON.stringify(detail),
  ];
  const rows = tx ? (await tx.query(sql, values)).rows : (await query(sql, values)).rows;
  return toRun(rows[0]);
};

export const getRun = async (id: string): Promise<Run | null> => {
  const row = await one(`SELECT * FROM crawl_runs WHERE id = $1`, [id]);
  return row ? toRun(row) : null;
};

export const latestRun = async (profileId: string): Promise<Run | null> => {
  const row = await one(
    `SELECT * FROM crawl_runs WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [profileId]
  );
  return row ? toRun(row) : null;
};

export const markRunStarted = async (runId: string): Promise<void> => {
  await query(
    `UPDATE crawl_runs SET status = 'running',
                           started_at = COALESCE(started_at, now()),
                           updated_at = now()
      WHERE id = $1 AND status = 'queued'`,
    [runId]
  );
};

export const patchRun = async (runId: string, detail: Record<string, any>): Promise<void> => {
  await query(
    `UPDATE crawl_runs SET detail = detail || $2::jsonb, updated_at = now() WHERE id = $1`,
    [runId, JSON.stringify(detail)]
  );
};

/**
 * A run finishes when none of its jobs are outstanding. Derived from the jobs
 * themselves rather than tracked separately, so a job that dies to the reaper
 * still moves its run along.
 */
export const settleRun = async (runId: string): Promise<RunStatus | null> => {
  const row = await one<{ status: RunStatus }>(
    `WITH counts AS (
       SELECT count(*) FILTER (WHERE status IN ('queued','running'))    AS pending,
              count(*) FILTER (WHERE status = 'succeeded')              AS ok,
              count(*) FILTER (WHERE status IN ('failed','dead'))       AS bad
         FROM jobs WHERE run_id = $1
     )
     UPDATE crawl_runs r
        SET status = CASE
              WHEN (SELECT pending FROM counts) > 0 THEN 'running'::run_status
              WHEN (SELECT bad FROM counts) = 0     THEN 'succeeded'::run_status
              WHEN (SELECT ok  FROM counts) = 0     THEN 'failed'::run_status
              ELSE 'partial'::run_status
            END,
            finished_at = CASE WHEN (SELECT pending FROM counts) > 0 THEN NULL ELSE now() END,
            updated_at = now()
      WHERE r.id = $1 AND r.status <> 'cancelled'
      RETURNING r.status`,
    [runId]
  );
  return row?.status ?? null;
};

export interface RunProgress {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
}

export const runProgress = async (runId: string): Promise<RunProgress> => {
  const row = await one(
    `SELECT count(*) FILTER (WHERE status = 'queued')            AS queued,
            count(*) FILTER (WHERE status = 'running')           AS running,
            count(*) FILTER (WHERE status = 'succeeded')         AS succeeded,
            count(*) FILTER (WHERE status IN ('failed','dead'))  AS failed,
            count(*)                                             AS total
       FROM jobs WHERE run_id = $1`,
    [runId]
  );
  return {
    queued: Number(row?.queued ?? 0),
    running: Number(row?.running ?? 0),
    succeeded: Number(row?.succeeded ?? 0),
    failed: Number(row?.failed ?? 0),
    total: Number(row?.total ?? 0),
  };
};

/**
 * Ends a run without it counting as a failure. Used when the work was correctly
 * *not* done — a duplicate library the user has to decide about — as distinct
 * from work that was attempted and broke.
 */
/**
 * Removes a run that turned out to represent no work — every job it would have
 * held was deduped against one still outstanding. Left in place it becomes the
 * profile's "latest run" and hides the one actually making progress.
 */
export const deleteRun = async (runId: string): Promise<void> => {
  await query(`DELETE FROM crawl_runs WHERE id = $1`, [runId]);
};

/** The run already carrying this work, so a duplicate request polls the real one. */
export const runForDedupeKeys = async (keys: string[]): Promise<string | null> => {
  if (!keys.length) return null;
  const row = await one<{ run_id: string }>(
    `SELECT run_id FROM jobs
      WHERE dedupe_key = ANY($1::text[])
        AND status IN ('queued', 'running')
        AND run_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [keys]
  );
  return row?.run_id ?? null;
};

export const cancelRun = async (runId: string, detail: Record<string, any> = {}): Promise<void> => {
  await query(
    `UPDATE crawl_runs SET status = 'cancelled', finished_at = now(),
                           detail = detail || $2::jsonb, updated_at = now()
      WHERE id = $1`,
    [runId, JSON.stringify(detail)]
  );
};

export const listRunJobs = async (runId: string): Promise<Job[]> =>
  (await many(`SELECT * FROM jobs WHERE run_id = $1 ORDER BY created_at`, [runId])).map(toJob);
