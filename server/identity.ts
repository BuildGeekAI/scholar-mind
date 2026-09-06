import { timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

export interface User {
  id: string;
  email: string;
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
 * Programmatic access — the MCP server, scripts, anything without a browser
 * session. The key is compared in constant time and identifies a single
 * configured user, so an integration reads and writes exactly the library the
 * browser sees.
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

type KeyOutcome = 'valid' | 'invalid' | 'absent';

const checkApiKey = (headers: Headers): KeyOutcome => {
  const bearer = headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const presented = headers.get('x-api-key') || bearer || '';
  if (!presented) return 'absent';
  return apiKey && secretsMatch(presented, apiKey) ? 'valid' : 'invalid';
};

export const resolveUser = async (headers: Headers): Promise<User | null> => {
  // Checked before anything else, so an API key works in every environment.
  const outcome = checkApiKey(headers);
  if (outcome === 'valid') return apiUser;

  // A key that was offered and rejected is refused outright, even in
  // development. Falling through to the dev user would mean a misconfigured
  // integration appeared to work locally and failed only in production.
  if (outcome === 'invalid') return null;

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
