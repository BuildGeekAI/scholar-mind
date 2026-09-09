import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, query } from './db';

/**
 * Browser sessions, and the policy for who may open one.
 *
 * Deliberately provider-agnostic. This file used to run a Google OAuth
 * authorization-code flow itself; that moved to Firebase, which handles
 * passwords, resets, lockout and Google sign-in alike. What stayed is the part
 * that was never about Google: a session is a row, so it can be revoked, and
 * only a hash of the cookie is stored, so a leaked database is not a set of live
 * logins.
 */

/**
 * Domains allowed to sign in, or empty for anyone.
 *
 * Checked against a verified hosted domain where the provider asserts one,
 * falling back to the address. An unset allowlist is open — which was merely
 * loose when sign-in required a Google account, and is wide open now that anyone
 * can register an address and a password. With the default profile visibility of
 * `org`, a stranger who signs into the same org can read its libraries.
 */
const allowedDomains = (): string[] =>
  (process.env.AUTH_ALLOWED_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);

export const domainAllowed = (email: string, hostedDomain?: string): boolean => {
  const allowed = allowedDomains();
  // '*' is how a deployment says "open registration, deliberately" and satisfies
  // the startup guard. Empty means the same thing but by omission, which is the
  // case the guard exists to catch.
  if (!allowed.length || allowed.includes('*')) return true;
  const domain = (hostedDomain || email.split('@')[1] || '').toLowerCase();
  return allowed.includes(domain);
};

/** True once *some* provider can issue sessions. */
export const isConfigured = (): boolean => !!process.env.FIREBASE_PROJECT_ID;

// --- Sessions -----------------------------------------------------------------

export const SESSION_COOKIE = 'sm_session';

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const randomToken = (): string => randomBytes(32).toString('hex');

/** Constant-time, so a wrong token leaks nothing by timing. */
const digestsMatch = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** What a provider tells us about a person, reduced to what we store. */
export interface ExternalIdentity {
  /** 'firebase' today. Prefixes external_id, so providers cannot collide. */
  provider: string;
  /** The provider's stable id for this person — never their address. */
  subject: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface SessionUser {
  userId: string;
  externalId: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Upserts the person and opens a session. The `users` row is keyed on Google's
 * subject, so a changed display name or even a changed address still resolves to
 * the same person and the same libraries.
 */
export const signIn = async (
  identity: ExternalIdentity,
  userAgent?: string
): Promise<{ token: string; user: SessionUser }> => {
  const externalId = `${identity.provider}:${identity.subject}`;

  const user = await one(
    `INSERT INTO users (external_id, email, display_name, picture, auth_provider)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (external_id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       picture = COALESCE(EXCLUDED.picture, users.picture)
     RETURNING id, external_id, email, display_name, picture`,
    [externalId, identity.email, identity.name ?? null, identity.picture ?? null, identity.provider]
  );

  const token = randomToken();
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [user!.id, hash(token), SESSION_DAYS, (userAgent ?? '').slice(0, 300) || null]
  );

  return {
    token,
    user: {
      userId: user!.id,
      externalId: user!.external_id,
      email: user!.email,
      name: user!.display_name ?? undefined,
      picture: user!.picture ?? undefined,
    },
  };
};

/** Resolves a session cookie, or null for absent, unknown, or expired. */
export const verifySession = async (token: string): Promise<SessionUser | null> => {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const row = await one(
    `SELECT s.id, s.token_hash, s.expires_at,
            u.id AS user_id, u.external_id, u.email, u.display_name, u.picture
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hash(token)]
  ).catch(() => null);
  if (!row) return null;

  if (!digestsMatch(hash(token), row.token_hash)) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  // Not awaited into the request path: every page load would otherwise pay for
  // a write.
  void query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.id]).catch(() => {});

  return {
    userId: row.user_id,
    externalId: row.external_id,
    email: row.email,
    name: row.display_name ?? undefined,
    picture: row.picture ?? undefined,
  };
};

export const signOut = async (token: string): Promise<void> => {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hash(token)]).catch(() => {});
};

/** Expired rows are dead weight; the worker sweeps them. */
export const purgeExpiredSessions = async (): Promise<number> => {
  const { rowCount } = await query(`DELETE FROM sessions WHERE expires_at < now()`);
  return rowCount ?? 0;
};
