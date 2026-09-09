import { OAuth2Client } from 'google-auth-library';
import { ExternalIdentity } from './session';

/**
 * Verifying Firebase ID tokens.
 *
 * A Firebase ID token is an ordinary RS256 JWT: issuer
 * `https://securetoken.google.com/<project>`, audience `<project>`, signed with
 * Google's *securetoken* keys. `identity.ts` already verifies IAP assertions
 * with the same primitive, so this needs a fetch and a cache rather than
 * `firebase-admin` — a large dependency carrying its own gRPC and credential
 * machinery for one signature check we can already perform.
 *
 * That choice matches how this repository has consistently gone: no dotenv, no
 * migration framework, no cookie parser.
 */

export const PROVIDER = 'firebase';

const projectId = (): string =>
  process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';

export const isConfigured = (): boolean => !!projectId();

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface CertCache {
  keys: Record<string, string>;
  expiresAt: number;
}

let cache: CertCache | null = null;

/**
 * Google publishes a rotation window in `Cache-Control`, so honour it rather
 * than picking an interval. A failed refresh keeps the previous set: stale keys
 * still verify tokens signed before the rotation, whereas no keys reject
 * everything and look like total auth failure.
 */
const fetchCerts = async (): Promise<Record<string, string> | null> => {
  try {
    const response = await fetch(CERT_URL);
    if (!response.ok) throw new Error(`certs ${response.status}`);

    const maxAge = Number(
      /max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] ?? 3600
    );
    const keys = (await response.json()) as Record<string, string>;
    cache = { keys, expiresAt: Date.now() + maxAge * 1000 };
    return keys;
  } catch (e) {
    console.error('Could not refresh Firebase signing keys:', e);
    return cache?.keys ?? null;
  }
};

const certs = async (kid?: string): Promise<Record<string, string> | null> => {
  const fresh = cache && cache.expiresAt > Date.now();
  // An unknown `kid` means a rotation we have not seen; refetch even if the
  // cache has not expired, or every token signed with the new key is rejected.
  if (fresh && (!kid || cache!.keys[kid])) return cache!.keys;
  return fetchCerts();
};

const client = new OAuth2Client();

/** Reads the `kid` without trusting the token — it is only a cache hint. */
const kidOf = (token: string): string | undefined => {
  try {
    const [header] = token.split('.');
    const padded = header + '='.repeat((4 - (header.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString()).kid;
  } catch {
    return undefined;
  }
};

export interface FirebaseIdentity extends ExternalIdentity {
  emailVerified: boolean;
  /** 'password', 'google.com', … — which provider the person actually used. */
  signInProvider?: string;
}

/**
 * Verifies a Firebase ID token and reduces it to an identity.
 *
 * Returns null for every failure alike — unknown key, bad signature, wrong
 * issuer or audience, expired, malformed — so a caller cannot tell them apart
 * and probe for which part of a forged token was wrong.
 */
export const verifyFirebaseToken = async (idToken: string): Promise<FirebaseIdentity | null> => {
  const project = projectId();
  if (!project || !idToken) return null;

  const keys = await certs(kidOf(idToken));
  if (!keys) return null;

  try {
    const ticket = await client.verifySignedJwtWithCertsAsync(
      idToken,
      keys,
      project,
      [`https://securetoken.google.com/${project}`]
    );
    const payload = ticket.getPayload() as any;
    if (!payload?.sub || !payload.email) return null;

    return {
      provider: PROVIDER,
      subject: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      emailVerified: payload.email_verified === true,
      signInProvider: payload.firebase?.sign_in_provider,
    };
  } catch (e) {
    // Deliberately not logged at error level: a rejected token is the expected
    // outcome of a stale tab or a replayed request, not an incident.
    return null;
  }
};
