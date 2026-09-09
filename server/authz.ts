import { many, one } from './db';
import { User } from './identity';

/**
 * Authorization for the multi-tenant model.
 *
 * Every read and write goes through exactly one predicate builder. There are no
 * ad-hoc `WHERE owner_id = ...` clauses anywhere else in the server, because the
 * failure mode here is not a broken page — it is one tenant reading another's
 * library, silently and successfully.
 */

export type Visibility = 'private' | 'team' | 'org';
export type Role = 'viewer' | 'editor' | 'owner';
export type Access = 'view' | 'edit' | 'own';
export type PrincipalType = 'user' | 'team' | 'org';

export interface Ctx {
  userId: string;
  orgId: string;
  teamId: string;
  email: string;
}

/**
 * Local development runs without ACLs, as specified. It is a *collapse of the
 * predicate*, not a second code path: the columns, joins and query shape are
 * identical, so setting ACL_ENABLED=true locally exercises production exactly.
 * An ACL that only exists in production is one that is only debugged there.
 */
export const aclEnabled = (): boolean => {
  const raw = process.env.ACL_ENABLED;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
};

// --- The decision, as a pure function ---------------------------------------

export interface AccessFacts {
  isOwner: boolean;
  visibility: Visibility;
  /** The viewer belongs to the resource's org. */
  inOrg: boolean;
  /** The viewer belongs to the resource's team. */
  inTeam: boolean;
  /** Roles from every grant that reaches this viewer — direct, via team, via org. */
  grants: Role[];
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * The strongest role a viewer holds. Visibility and grants are additive: a grant
 * can only widen access, never narrow it, so a `private` profile shared with one
 * colleague is readable by exactly its owner and that colleague.
 */
export const effectiveRole = (facts: AccessFacts): Role | null => {
  if (facts.isOwner) return 'owner';

  const candidates: Role[] = [...facts.grants];
  if (facts.visibility === 'org' && facts.inOrg) candidates.push('viewer');
  if (facts.visibility === 'team' && facts.inTeam) candidates.push('viewer');

  if (!candidates.length) return null;
  return candidates.reduce((best, r) => (RANK[r] > RANK[best] ? r : best));
};

const REQUIRED: Record<Access, number> = { view: 1, edit: 2, own: 3 };

export const roleAllows = (role: Role | null, access: Access): boolean =>
  !!role && RANK[role] >= REQUIRED[access];

// --- The same decision, as SQL ----------------------------------------------

/**
 * A predicate restricting `alias` to resources the user in `userParam` may
 * access. `userParam` is a placeholder such as `'$1'`, so callers keep control
 * of their own parameter numbering.
 *
 * Returns `TRUE` when ACLs are off — same shape, no filtering.
 */
export const visibilityPredicate = (
  alias: string,
  userParam: string,
  access: Access = 'view',
  resourceType = 'profile'
): string => {
  // Still references `userParam`, and deliberately so: callers bind the same
  // values either way, and Postgres rejects a statement whose parameters go
  // unused ("bind message supplies 1 parameters, but prepared statement
  // requires 0"). The cast is required too — with nothing to compare against,
  // the parameter's type cannot be inferred. The predicate collapses to true
  // without changing the call shape.
  if (!aclEnabled()) return `(${userParam}::text IS NOT NULL)`;

  const grantRoles =
    access === 'view' ? `('viewer','editor','owner')` : `('editor','owner')`;

  const reachesPrincipal = `(
        (g.principal_type = 'user' AND g.principal_id = ${userParam})
     OR (g.principal_type = 'team' AND EXISTS (
           SELECT 1 FROM team_members tmg
           WHERE tmg.team_id = g.principal_id AND tmg.user_id = ${userParam}))
     OR (g.principal_type = 'org'  AND EXISTS (
           SELECT 1 FROM org_members omg
           WHERE omg.org_id  = g.principal_id AND omg.user_id = ${userParam}))
  )`;

  const grantClause = `EXISTS (
    SELECT 1 FROM resource_grants g
    WHERE g.resource_type = '${resourceType}'
      AND g.resource_id = ${alias}.id
      AND g.role::text IN ${grantRoles}
      AND ${reachesPrincipal}
  )`;

  // 'own' is the owner column alone: ownership is not grantable.
  if (access === 'own') return `${alias}.owner_id = ${userParam}`;

  // 'edit' is the owner or an editor/owner grant. Visibility never confers write.
  if (access === 'edit') return `(${alias}.owner_id = ${userParam} OR ${grantClause})`;

  return `(
    ${alias}.owner_id = ${userParam}
    OR (${alias}.visibility = 'org' AND EXISTS (
          SELECT 1 FROM org_members om
          WHERE om.org_id = ${alias}.org_id AND om.user_id = ${userParam}))
    OR (${alias}.visibility = 'team' AND EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = ${alias}.team_id AND tm.user_id = ${userParam}))
    OR ${grantClause}
  )`;
};

// --- Reading a concrete decision back ----------------------------------------

interface FactRow {
  owner_id: string;
  visibility: Visibility;
  in_org: boolean;
  in_team: boolean;
  grants: Role[] | null;
}

/**
 * The viewer's role on one profile, assembled from the same facts the SQL
 * predicate uses. Used where the answer itself is needed — rendering a sharing
 * UI, deciding whether to show a delete button — rather than as a filter.
 */
export const profileRole = async (ctx: Ctx, profileId: string): Promise<Role | null> => {
  const row = await one<FactRow>(
    `SELECT p.owner_id,
            p.visibility,
            EXISTS (SELECT 1 FROM org_members om
                    WHERE om.org_id = p.org_id AND om.user_id = $2)   AS in_org,
            EXISTS (SELECT 1 FROM team_members tm
                    WHERE tm.team_id = p.team_id AND tm.user_id = $2) AS in_team,
            ARRAY(
              SELECT g.role::text FROM resource_grants g
              WHERE g.resource_type = 'profile' AND g.resource_id = p.id
                AND ( (g.principal_type = 'user' AND g.principal_id = $2)
                   OR (g.principal_type = 'team' AND EXISTS (
                         SELECT 1 FROM team_members t2
                         WHERE t2.team_id = g.principal_id AND t2.user_id = $2))
                   OR (g.principal_type = 'org' AND EXISTS (
                         SELECT 1 FROM org_members o2
                         WHERE o2.org_id = g.principal_id AND o2.user_id = $2)) )
            ) AS grants
       FROM profiles p
      WHERE p.id = $1`,
    [profileId, ctx.userId]
  );
  if (!row) return null;

  // With ACLs off every reachable profile is fully writable, matching the
  // predicate's TRUE. The row lookup still happens, so a missing profile is
  // still a 404 rather than a 200 in both modes.
  if (!aclEnabled()) return 'owner';

  return effectiveRole({
    isOwner: row.owner_id === ctx.userId,
    visibility: row.visibility,
    inOrg: row.in_org,
    inTeam: row.in_team,
    grants: row.grants ?? [],
  });
};

// --- Grants -------------------------------------------------------------------

export interface Grant {
  id: string;
  resourceType: string;
  resourceId: string;
  principalType: PrincipalType;
  principalId: string;
  role: Role;
  email?: string;
  name?: string;
}

export const listGrants = async (resourceId: string, resourceType = 'profile'): Promise<Grant[]> =>
  (
    await many(
      `SELECT g.id, g.resource_type, g.resource_id, g.principal_type, g.principal_id,
              g.role, u.email, COALESCE(u.display_name, t.name, o.name) AS name
         FROM resource_grants g
         LEFT JOIN users u ON g.principal_type = 'user' AND u.id = g.principal_id
         LEFT JOIN teams t ON g.principal_type = 'team' AND t.id = g.principal_id
         LEFT JOIN orgs  o ON g.principal_type = 'org'  AND o.id = g.principal_id
        WHERE g.resource_type = $1 AND g.resource_id = $2
        ORDER BY g.created_at`,
      [resourceType, resourceId]
    )
  ).map(r => ({
    id: r.id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    principalType: r.principal_type,
    principalId: r.principal_id,
    role: r.role,
    email: r.email ?? undefined,
    name: r.name ?? undefined,
  }));

/**
 * Sharing is with *existing* users only — there is no invitation flow, and
 * granting to an address nobody has signed in as would create a grant that
 * silently matches nothing.
 */
export const findUserByEmail = async (email: string): Promise<User & { uuid: string } | null> => {
  const row = await one(
    `SELECT id, external_id, email FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return row ? { uuid: row.id, id: row.external_id, email: row.email } : null;
};

export const grantAccess = async (
  ctx: Ctx,
  resourceId: string,
  principalType: PrincipalType,
  principalId: string,
  role: Role,
  resourceType = 'profile'
): Promise<void> => {
  await one(
    `INSERT INTO resource_grants
       (resource_type, resource_id, principal_type, principal_id, role, granted_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
       DO UPDATE SET role = EXCLUDED.role
     RETURNING id`,
    [resourceType, resourceId, principalType, principalId, role, ctx.userId]
  );
};

export const revokeAccess = async (
  resourceId: string,
  principalType: PrincipalType,
  principalId: string,
  resourceType = 'profile'
): Promise<void> => {
  await one(
    `DELETE FROM resource_grants
      WHERE resource_type = $1 AND resource_id = $2
        AND principal_type = $3 AND principal_id = $4
      RETURNING id`,
    [resourceType, resourceId, principalType, principalId]
  );
};
