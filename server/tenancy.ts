import { Ctx } from './authz';
import { one, transaction } from './db';
import { User } from './identity';

/**
 * Maps an authenticated caller onto a tenant.
 *
 * `identity.ts` answers *who* — an IAP subject, the API key's user, or the dev
 * user. This answers *where*: which org and team their work belongs to. Kept
 * separate so the authentication rules stay readable on their own.
 *
 * Everything starts in demo/demo/demo, as specified. A caller with no
 * membership is enrolled there on first sight, so a fresh deployment is usable
 * before any org administration exists.
 */
export const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';
export const DEMO_TEAM_ID = '00000000-0000-0000-0000-000000000002';

interface Row {
  user_id: string;
  org_id: string | null;
  team_id: string | null;
}

const cache = new Map<string, Ctx>();

export const resolveContext = async (user: User): Promise<Ctx> => {
  const cached = cache.get(user.id);
  if (cached && cached.email === user.email) return cached;

  const row = await transaction(async tx => {
    // The external id is the natural key: it is what IAP and the API key both
    // hand us, and it is stable across sessions.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (external_id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [user.id, user.email, user.email.split('@')[0]]
    );
    const userId = rows[0].id;

    const membership = await tx.query<Row>(
      `SELECT $1::uuid AS user_id,
              (SELECT org_id  FROM org_members  WHERE user_id = $1 ORDER BY created_at LIMIT 1) AS org_id,
              (SELECT team_id FROM team_members WHERE user_id = $1 ORDER BY created_at LIMIT 1) AS team_id`,
      [userId]
    );
    const found = membership.rows[0];
    if (found.org_id && found.team_id) return found;

    // No membership yet — enrol into demo. ON CONFLICT keeps this safe under
    // concurrent first requests from the same new user.
    await tx.query(
      `INSERT INTO org_members (org_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [DEMO_ORG_ID, userId]
    );
    await tx.query(
      `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [DEMO_TEAM_ID, userId]
    );
    return { user_id: userId, org_id: found.org_id ?? DEMO_ORG_ID, team_id: found.team_id ?? DEMO_TEAM_ID };
  });

  const ctx: Ctx = {
    userId: row.user_id,
    orgId: row.org_id ?? DEMO_ORG_ID,
    teamId: row.team_id ?? DEMO_TEAM_ID,
    email: user.email,
  };
  cache.set(user.id, ctx);
  return ctx;
};

/** Membership changes invalidate the mapping; used by org administration. */
export const forgetContext = (externalId?: string): void => {
  if (externalId) cache.delete(externalId);
  else cache.clear();
};

export const listOrgUsers = async (orgId: string) =>
  (
    await one<{ users: any[] }>(
      `SELECT COALESCE(json_agg(json_build_object(
                'id', u.id, 'email', u.email, 'name', u.display_name
              ) ORDER BY u.email), '[]'::json) AS users
         FROM org_members om JOIN users u ON u.id = om.user_id
        WHERE om.org_id = $1`,
      [orgId]
    )
  )?.users ?? [];
