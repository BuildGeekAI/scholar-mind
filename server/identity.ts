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
export const resolveUser = async (headers: Headers): Promise<User | null> => {
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
