import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError, sendPasswordReset, signIn, signUp } from '../services/firebase';

/**
 * The client's REST calls to Firebase.
 *
 * The mapping from Firebase's error codes to sentences is the part worth
 * pinning. Firebase deliberately returns one code for a wrong password and an
 * unknown address; if we ever split them, the sign-in form becomes a way to
 * discover who has an account. That regression would be invisible — the form
 * would look more helpful, not less safe.
 */

const KEY = 'test-api-key';

const respond = (body: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );

const fail = (code: string) => respond({ error: { message: code } }, 400);

afterEach(() => vi.unstubAllGlobals());

describe('signIn', () => {
  it('posts to signInWithPassword with the key and returns the token', async () => {
    respond({ idToken: 'tok', email: 'a@b.c', localId: 'uid' });
    const session = await signIn(KEY, 'a@b.c', 'secret');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('accounts:signInWithPassword');
    expect(url).toContain(`key=${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@b.c',
      password: 'secret',
      returnSecureToken: true,
    });
    expect(session.idToken).toBe('tok');
  });

  it('never puts the password in the URL', async () => {
    respond({ idToken: 'tok', email: 'a@b.c', localId: 'uid' });
    await signIn(KEY, 'a@b.c', 'hunter2');
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).not.toContain('hunter2');
  });
});

describe('signUp', () => {
  it('posts to signUp', async () => {
    respond({ idToken: 'tok', email: 'a@b.c', localId: 'uid' });
    await signUp(KEY, 'a@b.c', 'secret');
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('accounts:signUp');
  });
});

describe('error mapping', () => {
  /**
   * The property that matters: a wrong password and an unknown address must be
   * indistinguishable to whoever is typing.
   */
  it('says the same thing for a wrong password and an unknown address', async () => {
    fail('EMAIL_NOT_FOUND');
    const unknown = await signIn(KEY, 'a@b.c', 'x').catch(e => e.message);
    fail('INVALID_PASSWORD');
    const wrong = await signIn(KEY, 'a@b.c', 'x').catch(e => e.message);
    fail('INVALID_LOGIN_CREDENTIALS');
    const combined = await signIn(KEY, 'a@b.c', 'x').catch(e => e.message);

    expect(unknown).toBe(wrong);
    expect(wrong).toBe(combined);
  });

  it('turns codes into sentences a person can act on', async () => {
    const cases: Array<[string, RegExp]> = [
      ['EMAIL_EXISTS', /already an account/i],
      ['WEAK_PASSWORD', /at least six characters/i],
      ['TOO_MANY_ATTEMPTS_TRY_LATER', /too many attempts/i],
      ['USER_DISABLED', /disabled/i],
      ['INVALID_EMAIL', /email address/i],
      ['OPERATION_NOT_ALLOWED', /switched off/i],
    ];
    for (const [code, expected] of cases) {
      fail(code);
      await expect(signUp(KEY, 'a@b.c', 'x')).rejects.toThrow(expected);
    }
  });

  it('handles the trailing detail Firebase appends to some codes', async () => {
    fail('WEAK_PASSWORD : Password should be at least 6 characters');
    await expect(signUp(KEY, 'a@b.c', 'x')).rejects.toThrow(/at least six characters/i);
  });

  it('falls back to a generic message for a code it does not know', async () => {
    fail('SOME_FUTURE_CODE');
    await expect(signIn(KEY, 'a@b.c', 'x')).rejects.toThrow(/Sign-in failed/);
  });

  it('never surfaces Firebase’s raw code to the user', async () => {
    fail('INVALID_LOGIN_CREDENTIALS');
    const message = await signIn(KEY, 'a@b.c', 'x').catch(e => e.message);
    expect(message).not.toMatch(/INVALID_LOGIN_CREDENTIALS/);
  });

  it('keeps the code on the error for callers that need to branch', async () => {
    fail('EMAIL_EXISTS');
    const error = await signUp(KEY, 'a@b.c', 'x').catch(e => e);
    expect(error).toBeInstanceOf(FirebaseError);
    expect((error as FirebaseError).code).toBe('EMAIL_EXISTS');
  });

  it('survives a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    await expect(signIn(KEY, 'a@b.c', 'x')).rejects.toThrow(/Sign-in failed/);
  });
});

describe('sendPasswordReset', () => {
  it('asks for a reset code by email', async () => {
    respond({ email: 'a@b.c' });
    await sendPasswordReset(KEY, 'a@b.c');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('accounts:sendOobCode');
    expect(JSON.parse(init.body as string)).toEqual({
      requestType: 'PASSWORD_RESET',
      email: 'a@b.c',
    });
  });
});
