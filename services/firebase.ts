/**
 * Firebase Authentication over its REST API, with no SDK.
 *
 * The reason to take `firebase/auth` is its token-refresh machinery, and we do
 * not need it: the ID token is exchanged for a session cookie immediately and
 * never used again. So sign-in, sign-up, password reset and verification are
 * four fetches, and the client bundle is unchanged.
 *
 * The Web API key is public by design — it identifies the project and
 * authorises nothing on its own.
 */

const ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts';

export interface FirebaseSession {
  idToken: string;
  email: string;
  localId: string;
}

/**
 * Firebase's codes, turned into sentences someone can act on.
 *
 * `INVALID_LOGIN_CREDENTIALS` deliberately covers both a wrong password and an
 * unknown address — Firebase does not distinguish them, and neither does this,
 * because doing so would turn the sign-in form into a way to discover who has
 * an account.
 */
const MESSAGES: Record<string, string> = {
  EMAIL_EXISTS: 'There is already an account with that address. Try signing in.',
  OPERATION_NOT_ALLOWED: 'Email and password sign-in is switched off for this project.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
  EMAIL_NOT_FOUND: 'That email address or password is not right.',
  INVALID_PASSWORD: 'That email address or password is not right.',
  INVALID_LOGIN_CREDENTIALS: 'That email address or password is not right.',
  USER_DISABLED: 'That account has been disabled.',
  INVALID_EMAIL: 'That does not look like an email address.',
  MISSING_PASSWORD: 'Enter a password.',
  WEAK_PASSWORD: 'Passwords need to be at least six characters.',
};

const readable = (raw: string): string => {
  // Codes arrive as "WEAK_PASSWORD : Password should be at least 6 characters".
  const code = raw.split(':')[0].trim();
  return MESSAGES[code] ?? 'Sign-in failed. Please try again.';
};

export class FirebaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const call = async (apiKey: string, method: string, body: unknown): Promise<any> => {
  const response = await fetch(`${ENDPOINT}:${method}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const raw = data?.error?.message ?? 'UNKNOWN';
    throw new FirebaseError(raw.split(':')[0].trim(), readable(raw));
  }
  return data;
};

export const signUp = (apiKey: string, email: string, password: string): Promise<FirebaseSession> =>
  call(apiKey, 'signUp', { email, password, returnSecureToken: true });

export const signIn = (apiKey: string, email: string, password: string): Promise<FirebaseSession> =>
  call(apiKey, 'signInWithPassword', { email, password, returnSecureToken: true });

/** Sent on registration: a fresh password account is always unverified. */
export const sendVerificationEmail = (apiKey: string, idToken: string): Promise<void> =>
  call(apiKey, 'sendOobCode', { requestType: 'VERIFY_EMAIL', idToken });

export const sendPasswordReset = (apiKey: string, email: string): Promise<void> =>
  call(apiKey, 'sendOobCode', { requestType: 'PASSWORD_RESET', email });
