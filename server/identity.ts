import { timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { KeyScope, verifyKey } from './apiKeys';

export interface User {
  id: string;
  email: string;
  /**
   * Set only when the caller authenticated with an API key. A browser or IAP
   * session has no scope — it can do whatever its owner can do. `null` and
   * `'write'` differ in provenance, not in power.
   */
  scope?: KeyScope;
  /** Which key was used, for revocation and audit. */
  keyId?: string;
  /** True for any key-authenticated caller, including the bootstrap key. */
  viaKey?: boolean;
}

const IAP_JWT_HEADER = 'x-goog-iap-jwt-assertion';
const IAP_EMAIL_HEADER = 'x-goog-authenticated-user-email';

// Audience format: /projects/<PROJECT_NUMBER>/global/backendServices/<SERVICE_ID>
const iapAudience = process.env.IAP_AUDIENCE || '';
const isProduction = process.env.NODE_ENV === 'production';

const DEV_USER: User = { id: 'dev-user', email: 'dev@localhost' };

const client = new OAuth2Client();

/**
 * Resolves the caller from IAP headers.
 *
 * In production the signed JWT assertion is verified against Google's IAP keys.
 * The plain email header is deliberately NOT trusted on its own: anything able to
 * reach the service directly could forge it.
 */
/**
 * The deployment-wide bootstrap key.
 *
 * Superseded by per-user keys in `apiKeys.ts`, and kept because it is what
 * existing MCP clients and scripts are configured with. It maps to one
 * configured identity, so under multi-tenancy every caller presenting it is the
 * same person — which is exactly why it should not be handed out. Leave it
 * unset and mint per-user keys instead.
 */
const apiKey = process.env.SCHOLARMIND_API_KEY || '';
const apiUser: User = {
  id: process.env.API_USER_ID || DEV_USER.id,
  email: process.env.API_USER_EMAIL || 'api@localhost',
};

/** Length-independent comparison, so a wrong key leaks nothing by timing. */
const secretsMatch = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself be a leak.
  const padded = Buffer.alloc(Math.max(left.length, right.length));
  const other = Buffer.alloc(padded.length);
  left.copy(padded);
  right.copy(other);
  return timingSafeEqual(padded, other) && left.length === right.length;
};

type KeyOutcome = { status: 'valid'; user: User } | { status: 'invalid' } | { status: 'absent' };

const presentedKey = (headers: Headers): string => {
  const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return headers.get('x-api-key') || bearer || '';
};

/**
 * Per-user keys first, then the deployment-wide bootstrap key.
 *
 * That order matters: a per-user key carries a real identity and a scope, and
 * should win over the shared one whenever both would match. In practice they
 * cannot both match — the formats differ — but relying on that would be relying
 * on a coincidence.
 */
const checkApiKey = async (headers: Headers): Promise<KeyOutcome> => {
  const presented = presentedKey(headers);
  if (!presented) return { status: 'absent' };

  const verified = await verifyKey(presented);
  if (verified) {
    return {
      status: 'valid',
      user: {
        id: verified.externalId,
        email: verified.email,
        scope: verified.scope,
        keyId: verified.keyId,
        viaKey: true,
      },
    };
  }

  if (apiKey && secretsMatch(presented, apiKey)) {
    return { status: 'valid', user: { ...apiUser, viaKey: true } };
  }

  return { status: 'invalid' };
};

export const resolveUser = async (headers: Headers): Promise<User | null> => {
  // Checked before anything else, so an API key works in every environment.
  const outcome = await checkApiKey(headers);
  if (outcome.status === 'valid') return outcome.user;

  // A key that was offered and rejected is refused outright, even in
  // development. Falling through to the dev user would mean a misconfigured
  // integration appeared to work locally and failed only in production.
  if (outcome.status === 'invalid') return null;

  if (!isProduction) return DEV_USER;

  const assertion = headers.get(IAP_JWT_HEADER);
  if (!assertion) return null;

  if (!iapAudience) {
    console.error('IAP_AUDIENCE is unset; refusing to accept IAP assertions unverified.');
    return null;
  }

  try {
    const ticket = await client.verifySignedJwtWithCertsAsync(
      assertion,
      await client.getIapPublicKeys().then(keys => keys.pubkeys),
      iapAudience,
      ['https://cloud.google.com/iap']
    );
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return null;
    return { id: payload.sub, email: payload.email };
  } catch (e) {
    console.error('IAP assertion verification failed:', e);
    return null;
  }
};

/** Strips the `accounts.google.com:` prefix IAP puts on the email header. */
export const bareEmail = (value: string | null): string =>
  (value || '').replace(/^accounts\.google\.com:/, '');

export { IAP_EMAIL_HEADER };
