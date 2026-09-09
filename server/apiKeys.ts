import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { many, one, query } from './db';

/**
 * Per-user API keys.
 *
 * A key authenticates a person who already exists — it is a second way to
 * present an identity, not a new kind of principal. That is what makes it
 * cheap: the key inherits its owner's org, team and grants exactly, so no
 * separate permission model has to be kept in step with the ACLs.
 *
 * Format: `sm_<prefix>_<secret>`. The prefix is stored in clear and indexed, so
 * verification is one lookup followed by one comparison, rather than hashing a
 * presented key against every row. Only the SHA-256 of the whole key is stored:
 * a leaked database must not be a leaked set of credentials.
 */

export type KeyScope = 'read' | 'write';

export interface ApiKeyRecord {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  prefix: string;
  scope: KeyScope;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
}

const toRecord = (r: any): ApiKeyRecord => ({
  id: r.id,
  userId: r.user_id,
  orgId: r.org_id,
  name: r.name,
  prefix: r.prefix,
  scope: r.scope,
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : undefined,
  expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : undefined,
  revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : undefined,
  createdAt: new Date(r.created_at).getTime(),
});

const PREFIX_BYTES = 6; // 12 hex characters — enough to make collisions a non-event.
const SECRET_BYTES = 24;

export const hashKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

/** `sm_<12 hex>_<48 hex>` — recognisable at a glance in a log or a config file. */
export const mintKeyString = (): { key: string; prefix: string } => {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  return { key: `sm_${prefix}_${secret}`, prefix };
};

/** Splits a presented key without trusting its shape. */
export const prefixOf = (presented: string): string | null => {
  const match = /^sm_([0-9a-f]{12})_[0-9a-f]{32,}$/.exec((presented || '').trim());
  return match ? match[1] : null;
};

/** Length-independent comparison, so a wrong key leaks nothing by timing. */
const digestsMatch = (a: string, b: string): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

export interface VerifiedKey {
  keyId: string;
  /** The users.external_id of the owner — what identity.ts hands back. */
  externalId: string;
  email: string;
  scope: KeyScope;
}

/**
 * Resolves a presented key to its owner, or null.
 *
 * Returns null for every failure mode alike — unknown prefix, wrong secret,
 * revoked, expired — so a caller cannot distinguish "no such key" from "wrong
 * secret" and enumerate valid prefixes.
 */
export const verifyKey = async (presented: string): Promise<VerifiedKey | null> => {
  const prefix = prefixOf(presented);
  if (!prefix) return null;

  const row = await one(
    `SELECT k.id, k.hash, k.scope, k.expires_at, k.revoked_at, u.external_id, u.email
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.prefix = $1`,
    [prefix]
  ).catch(() => null);
  if (!row) return null;

  if (!digestsMatch(hashKey(presented), row.hash)) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // Best-effort and deliberately not awaited into the request path: a busy key
  // would otherwise pay for a write on every call.
  void query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});

  return {
    keyId: row.id,
    externalId: row.external_id,
    email: row.email,
    scope: row.scope,
  };
};

export const listKeys = async (userId: string): Promise<ApiKeyRecord[]> =>
  (
    await many(
      `SELECT * FROM api_keys
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [userId]
    )
  ).map(toRecord);

export interface MintedKey {
  record: ApiKeyRecord;
  /** Shown exactly once. Not recoverable — there is nowhere it is stored. */
  key: string;
}

export const createKey = async (
  userId: string,
  orgId: string,
  name: string,
  scope: KeyScope = 'read',
  expiresInDays?: number
): Promise<MintedKey> => {
  const { key, prefix } = mintKeyString();
  const row = await one(
    `INSERT INTO api_keys (user_id, org_id, name, prefix, hash, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             CASE WHEN $7::int IS NULL THEN NULL
                  ELSE now() + make_interval(days => $7::int) END)
     RETURNING *`,
    [userId, orgId, name.slice(0, 80) || 'Untitled key', prefix, hashKey(key), scope, expiresInDays ?? null]
  );
  return { record: toRecord(row), key };
};

/** Revocation is immediate and permanent; keys are cheap to re-mint. */
export const revokeKey = async (userId: string, keyId: string): Promise<boolean> => {
  const row = await one(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [keyId, userId]
  ).catch(() => null);
  return !!row;
};
