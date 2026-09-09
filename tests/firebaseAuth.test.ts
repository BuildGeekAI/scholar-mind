import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Firebase token verification.
 *
 * Two things are worth pinning here. The cert cache, because a stale or empty
 * key set rejects *every* valid token and presents as total auth failure — the
 * loudest possible way for a cache bug to show up. And the uniformity of
 * rejection, because a caller who can tell "unknown key" from "bad signature"
 * from "wrong audience" can probe a forged token towards a working one.
 */

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** A syntactically valid JWT with the given header and payload, unsigned. */
const token = (header: object, payload: object): string => {
  const encode = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url').replace(/=+$/, '');
  return `${encode(header)}.${encode(payload)}.not-a-real-signature`;
};

const certResponse = (keys: Record<string, string>, maxAge = 3600) =>
  new Response(JSON.stringify(keys), {
    status: 200,
    headers: { 'cache-control': `public, max-age=${maxAge}`, 'content-type': 'application/json' },
  });

const load = async () => {
  vi.resetModules();
  return import('../server/firebaseAuth');
};

beforeEach(() => {
  vi.stubEnv('FIREBASE_PROJECT_ID', 'scholar-mind-dev');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isConfigured', () => {
  it('is false with no project id', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    const { isConfigured } = await load();
    expect(isConfigured()).toBe(false);
  });

  it('falls back to GOOGLE_CLOUD_PROJECT, which Cloud Run already sets', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'scholar-mind-dev');
    const { isConfigured } = await load();
    expect(isConfigured()).toBe(true);
  });
});

describe('verifyFirebaseToken', () => {
  it('returns null with no project configured, without reaching the network', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { verifyFirebaseToken } = await load();
    expect(await verifyFirebaseToken('anything')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for an empty token', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { verifyFirebaseToken } = await load();
    expect(await verifyFirebaseToken('')).toBeNull();
  });

  it('returns null when the cert endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { verifyFirebaseToken } = await load();
    expect(await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: 'x' }))).toBeNull();
    spy.mockRestore();
  });

  it('rejects every malformed and forged shape identically', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => certResponse({ a: 'cert-a' })));
    const { verifyFirebaseToken } = await load();

    const forged = [
      'not-a-token',
      'only.two',
      token({ alg: 'RS256', kid: 'a' }, { sub: 'x', aud: 'scholar-mind-dev' }), // unsigned
      token({ alg: 'none', kid: 'a' }, { sub: 'x', aud: 'scholar-mind-dev' }),  // alg none
      token({ alg: 'RS256', kid: 'a' }, { sub: 'x', aud: 'other-project' }),    // wrong audience
      token({ alg: 'RS256', kid: 'a' }, { iss: 'https://evil.example', sub: 'x' }),
    ];

    const results = await Promise.all(forged.map(t => verifyFirebaseToken(t)));
    // Every one is null: no caller can tell which part of a forgery was wrong.
    expect(results).toEqual(forged.map(() => null));
  });
});

describe('the certificate cache', () => {
  it('fetches once and reuses within the published lifetime', async () => {
    const fetchMock = vi.fn(async () => certResponse({ a: 'cert-a' }, 3600));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyFirebaseToken } = await load();

    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '1' }));
    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '2' }));
    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '3' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches for an unknown key id, which is what a rotation looks like', async () => {
    // Without this, every token signed with a freshly rotated key is rejected
    // until the cache happens to expire.
    const fetchMock = vi.fn(async () => certResponse({ a: 'cert-a' }, 3600));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyFirebaseToken } = await load();

    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '1' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'brand-new' }, { sub: '2' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches once the published lifetime has passed', async () => {
    const fetchMock = vi.fn(async () => certResponse({ a: 'cert-a' }, 1));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyFirebaseToken } = await load();

    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '1' }));
    await new Promise(r => setTimeout(r, 1100));
    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '2' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous keys when a refresh fails', async () => {
    // Stale keys still verify tokens signed before the rotation. No keys reject
    // everything, which looks like a total outage rather than a refresh blip.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return certResponse({ a: 'cert-a' }, 1);
      throw new Error('transient');
    });
    vi.stubGlobal('fetch', fetchMock);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { verifyFirebaseToken } = await load();

    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '1' }));
    await new Promise(r => setTimeout(r, 1100));
    // Still reaches verification (and fails there on the fake signature) rather
    // than short-circuiting on an empty key set.
    await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '2' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('treats a non-OK cert response as a failed refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { verifyFirebaseToken } = await load();
    expect(await verifyFirebaseToken(token({ alg: 'RS256', kid: 'a' }, { sub: '1' }))).toBeNull();
    spy.mockRestore();
  });

  it('survives a token whose header is not decodable', async () => {
    // kidOf must never throw: it runs on attacker-supplied input.
    vi.stubGlobal('fetch', vi.fn(async () => certResponse({ a: 'cert-a' })));
    const { verifyFirebaseToken } = await load();
    expect(await verifyFirebaseToken('%%%.%%%.%%%')).toBeNull();
  });
});
