import { Ctx, visibilityPredicate } from './authz';
import { many, one, query } from './db';

/**
 * A crawler definition: where a library's content comes from, and how often to
 * go and look again.
 *
 * Browsing a scholar's profile is not a request that downloads papers. It
 * creates one of these (or reuses it), which raises an event, which a worker
 * consumes. The user watches the run rather than holding a connection open.
 */
export interface Crawler {
  id: string;
  orgId: string;
  teamId: string;
  ownerId: string;
  profileId: string;
  kind: string;
  /** A Google Scholar URL, or the scholar's name. */
  target: string;
  config: Record<string, any>;
  /** NULL means manual-only; otherwise how often to re-crawl. */
  intervalSeconds?: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
}

const toCrawler = (r: any): Crawler => ({
  id: r.id,
  orgId: r.org_id,
  teamId: r.team_id,
  ownerId: r.owner_id,
  profileId: r.profile_id,
  kind: r.kind,
  target: r.target,
  config: r.config ?? {},
  intervalSeconds: r.interval_seconds ?? undefined,
  enabled: r.enabled,
  lastRunAt: r.last_run_at ? new Date(r.last_run_at).getTime() : undefined,
  nextRunAt: r.next_run_at ? new Date(r.next_run_at).getTime() : undefined,
  createdAt: new Date(r.created_at).getTime(),
});

/** Crawlers are reached through their profile, so they inherit its sharing. */
export const listCrawlers = async (ctx: Ctx, profileId?: string): Promise<Crawler[]> =>
  (
    await many(
      `SELECT cr.* FROM crawlers cr
         JOIN profiles p ON p.id = cr.profile_id
        WHERE ($2::text IS NULL OR cr.profile_id = $2)
          AND ${visibilityPredicate('p', '$1', 'view')}
        ORDER BY cr.created_at DESC`,
      [ctx.userId, profileId ?? null]
    )
  ).map(toCrawler);

export const getCrawler = async (ctx: Ctx, id: string): Promise<Crawler | null> => {
  const row = await one(
    `SELECT cr.* FROM crawlers cr
       JOIN profiles p ON p.id = cr.profile_id
      WHERE cr.id = $2 AND ${visibilityPredicate('p', '$1', 'edit')}`,
    [ctx.userId, id]
  );
  return row ? toCrawler(row) : null;
};

export const upsertCrawler = async (
  ctx: Ctx,
  profileId: string,
  target: string,
  options: { kind?: string; intervalSeconds?: number | null; enabled?: boolean; config?: any } = {}
): Promise<Crawler> => {
  const row = await one(
    `INSERT INTO crawlers (org_id, team_id, owner_id, profile_id, kind, target,
                           config, interval_seconds, enabled, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $8::int IS NULL THEN NULL
                  ELSE now() + make_interval(secs => $8::int) END)
     RETURNING *`,
    [
      ctx.orgId,
      ctx.teamId,
      ctx.userId,
      profileId,
      options.kind ?? 'scholar',
      target,
      JSON.stringify(options.config ?? {}),
      options.intervalSeconds ?? null,
      options.enabled ?? true,
    ]
  );
  return toCrawler(row);
};

export const updateCrawler = async (
  ctx: Ctx,
  id: string,
  patch: { target?: string; intervalSeconds?: number | null; enabled?: boolean }
): Promise<Crawler | null> => {
  const existing = await getCrawler(ctx, id);
  if (!existing) return null;
  const row = await one(
    `UPDATE crawlers
        SET target = COALESCE($2, target),
            interval_seconds = $3,
            enabled = COALESCE($4, enabled),
            next_run_at = CASE WHEN $3::int IS NULL THEN NULL
                               ELSE now() + make_interval(secs => $3::int) END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      id,
      patch.target ?? null,
      patch.intervalSeconds === undefined ? existing.intervalSeconds ?? null : patch.intervalSeconds,
      patch.enabled ?? null,
    ]
  );
  return row ? toCrawler(row) : null;
};

export const deleteCrawler = async (ctx: Ctx, id: string): Promise<boolean> => {
  const existing = await getCrawler(ctx, id);
  if (!existing) return false;
  await query(`DELETE FROM crawlers WHERE id = $1`, [id]);
  return true;
};

/**
 * Scheduled crawlers whose interval has elapsed. Read by the worker's tick, so
 * it carries no visibility predicate — it is not acting for a caller.
 */
export const dueCrawlers = async (limit = 20): Promise<Crawler[]> =>
  (
    await many(
      `SELECT * FROM crawlers
        WHERE enabled AND interval_seconds IS NOT NULL
          AND (next_run_at IS NULL OR next_run_at <= now())
        ORDER BY next_run_at NULLS FIRST
        LIMIT $1`,
      [limit]
    )
  ).map(toCrawler);

export const markCrawlerRun = async (id: string): Promise<void> => {
  await query(
    `UPDATE crawlers
        SET last_run_at = now(),
            next_run_at = now() + make_interval(secs => interval_seconds),
            updated_at = now()
      WHERE id = $1`,
    [id]
  );
};
