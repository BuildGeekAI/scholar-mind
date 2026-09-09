import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { one, query } from './db';

/**
 * Google sign-in, replacing IAP.
 *
 * IAP gates access through GCP IAM: every user needs `iap.httpsResourceAccessor`
 * granted in the project, and the whole thing needs a Load Balancer and
 * certificates in front of Cloud Run. That cannot deliver self-serve signup, and
 * self-serve signup is the point of the tenancy model.
 *
 * The flow is the ordinary server-side authorization code exchange. It uses the
 * `google-auth-library` already present for IAP verification, so no new
 * dependency: `OAuth2Client` performs the exchange and verifies the returned ID
 * token's signature and audience.
 */

const clientId = () => process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

/**
 * Where Google sends the browser back. Must match a redirect URI registered on
 * the OAuth client exactly, including scheme and port.
 */
export const redirectUri = (): string =>
  `${(process.env.PUBLIC_ORIGIN || 'http://localhost:3000').replace(/\/$/, '')}/api/auth/callback`;

export const isConfigured = (): boolean => !!clientId() && !!clientSecret();

/**
 * Domains allowed to sign in, or empty for any Google account.
 *
 * Checked against the ID token's `hd` claim where there is one — a verified
 * Workspace domain — falling back to the address for consumer accounts. An
 * unset allowlist is open, which is right for a dev project and wrong for
 * anything holding real libraries: with the default profile visibility of
 * `org`, a stranger who signs into the same org can read it.
 */
const allowedDomains = (): string[] =>
  (process.env.AUTH_ALLOWED_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);

export const domainAllowed = (email: string, hostedDomain?: string): boolean => {
  const allowed = allowedDomains();
  if (!allowed.length) return true;
  const domain = (hostedDomain || email.split('@')[1] || '').toLowerCase();
  return allowed.includes(domain);
};

const client = () =>
  new OAuth2Client({
    clientId: clientId(),
    clientSecret: clientSecret(),
    redirectUri: redirectUri(),
  });

export interface GoogleIdentity {
  /** Google's `sub` — stable forever, and unlike an address never reassigned. */
  subject: string;
  email: string;
  name?: string;
  picture?: string;
  hostedDomain?: string;
}

/** The consent URL, carrying an opaque `state` the callback checks back. */
export const authorizationUrl = (state: string): string =>
  client().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    // The account chooser, rather than silently reusing whichever Google
    // account the browser last used — which is a real surprise on shared machines.
    prompt: 'select_account',
  });

/**
 * Exchanges the authorization code and verifies the ID token that comes back.
 * Returns null on any failure: a bad code, a token that does not verify, or one
 * whose audience is not us.
 */
export const exchangeCode = async (code: string): Promise<GoogleIdentity | null> => {
  try {
    const oauth = client();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.id_token) return null;

    // Verifies signature, issuer, audience and expiry against Google's keys.
    // Trusting the token without this would accept anything shaped like one.
    const ticket = await oauth.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId(),
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return null;

    // An unverified address must not be trusted: it would let someone sign up
    // as an address they do not control and land in that domain's org.
    if (payload.email_verified === false) return null;

    return {
      subject: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      hostedDomain: (payload as any).hd,
    };
  } catch (e) {
    console.error('Google token exchange failed:', e);
    return null;
  }
};

// --- Sessions -----------------------------------------------------------------

export const SESSION_COOKIE = 'sm_session';
export const STATE_COOKIE = 'sm_oauth_state';

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const randomToken = (): string => randomBytes(32).toString('hex');

/** Constant-time, so a wrong token leaks nothing by timing. */
const digestsMatch = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

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
  identity: GoogleIdentity,
  userAgent?: string
): Promise<{ token: string; user: SessionUser }> => {
  const externalId = `google:${identity.subject}`;

  const user = await one(
    `INSERT INTO users (external_id, email, display_name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       picture = COALESCE(EXCLUDED.picture, users.picture)
     RETURNING id, external_id, email, display_name, picture`,
    [externalId, identity.email, identity.name ?? null, identity.picture ?? null]
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
