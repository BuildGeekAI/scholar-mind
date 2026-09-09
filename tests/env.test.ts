import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * server/identity.ts gates *all* authentication on NODE_ENV. If a Cloud Run
 * revision ever starts without it, every caller resolves to the same dev
 * identity and every profile collapses into one shared namespace — silently,
 * while serving traffic. `gcloud run deploy --set-env-vars` replaces the whole
 * variable set, so a single forgetful deploy is all it takes.
 */
const loadEnvModule = async () => {
  vi.resetModules();
  return import('../server/env');
};

afterEach(() => vi.unstubAllEnvs());

describe('startup guard', () => {
  it('refuses to start on Cloud Run without NODE_ENV=production', async () => {
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'development');
    await expect(loadEnvModule()).rejects.toThrow(/NODE_ENV=production/);
  });

  it('names the offending service so the log says what to fix', async () => {
    vi.stubEnv('K_SERVICE', 'scholarmind-prod');
    vi.stubEnv('NODE_ENV', '');
    await expect(loadEnvModule()).rejects.toThrow(/scholarmind-prod/);
  });

  it('starts on Cloud Run when NODE_ENV is production', async () => {
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    vi.stubEnv('IAP_AUDIENCE', '/projects/1/global/backendServices/2');
    vi.stubEnv('GCS_BUCKET', 'bucket');
    await expect(loadEnvModule()).resolves.toBeDefined();
  });

  it('does not interfere with local development', async () => {
    vi.stubEnv('K_SERVICE', '');
    vi.stubEnv('NODE_ENV', 'development');
    await expect(loadEnvModule()).resolves.toBeDefined();
  });

  it('warns, but still starts, when IAP_AUDIENCE is missing', async () => {
    // Deliberate: the audience is only knowable after the first deploy, so
    // requiring it at startup would make the documented provisioning order
    // impossible. Requests are refused until it is set.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    vi.stubEnv('IAP_AUDIENCE', '');
    vi.stubEnv('GCS_BUCKET', 'bucket');
    await expect(loadEnvModule()).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/IAP_AUDIENCE/);
    warn.mockRestore();
  });

  it('warns when blobs would be written to ephemeral container disk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    vi.stubEnv('IAP_AUDIENCE', '/projects/1/global/backendServices/2');
    vi.stubEnv('GCS_BUCKET', '');
    await expect(loadEnvModule()).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/GCS_BUCKET/);
    warn.mockRestore();
  });
});

/**
 * The second fail-closed guard, added when sign-in moved to email and password.
 *
 * Before, an unset allowlist meant "anyone with a Google account" — loose. Now
 * it means anyone who can receive email, and new users land in the demo org
 * where profiles default to org-visible. So an omission is a data exposure, and
 * the same reasoning applies as to NODE_ENV: a crashed revision beats a serving
 * one that anybody can sign into.
 */
describe('open-registration guard', () => {
  it('refuses to start on Cloud Run with no allowlist', async () => {
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', '');
    await expect(loadEnvModule()).rejects.toThrow(/AUTH_ALLOWED_DOMAINS/);
  });

  it('says what the omission would actually allow', async () => {
    // The message has to be actionable in a log at 3am, not just correct.
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', '');
    await expect(loadEnvModule()).rejects.toThrow(/anyone who can receive email/);
  });

  it('starts with a domain list', async () => {
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com,example.org');
    await expect(loadEnvModule()).resolves.toBeDefined();
  });

  it('starts with "*", which is how a deployment says open on purpose', async () => {
    // The distinction the guard exists to draw: deliberate versus forgotten.
    vi.stubEnv('K_SERVICE', 'scholarmind');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', '*');
    await expect(loadEnvModule()).resolves.toBeDefined();
  });

  it('does not apply off Cloud Run, where the dev fallback governs', async () => {
    vi.stubEnv('K_SERVICE', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', '');
    await expect(loadEnvModule()).resolves.toBeDefined();
  });
});

describe('API key authentication', () => {
  const load = async () => {
    vi.resetModules();
    return import('../server/identity');
  };

  it('accepts the configured key in either header', async () => {
    vi.stubEnv('SCHOLARMIND_API_KEY', 'sk-test-1234567890');
    const { resolveUser } = await load();
    const viaHeader = await resolveUser(new Headers({ 'x-api-key': 'sk-test-1234567890' }));
    const viaBearer = await resolveUser(new Headers({ authorization: 'Bearer sk-test-1234567890' }));
    expect(viaHeader?.id).toBeTruthy();
    expect(viaBearer?.id).toBe(viaHeader?.id);
  });

  it('rejects a wrong key in production rather than falling through', async () => {
    vi.stubEnv('SCHOLARMIND_API_KEY', 'sk-test-1234567890');
    vi.stubEnv('NODE_ENV', 'production');
    const { resolveUser } = await load();
    expect(await resolveUser(new Headers({ 'x-api-key': 'wrong' }))).toBeNull();
  });

  it('rejects a wrong key in development too, instead of silently allowing it', async () => {
    // Otherwise a misconfigured integration works locally and fails only once
    // it is deployed, which is the worst place to find out.
    vi.stubEnv('SCHOLARMIND_API_KEY', 'sk-test-1234567890');
    vi.stubEnv('NODE_ENV', 'development');
    const { resolveUser } = await load();
    expect(await resolveUser(new Headers({ 'x-api-key': 'wrong' }))).toBeNull();
    // A request with no key at all is still the local browser.
    expect((await resolveUser(new Headers()))?.id).toBe('dev-user');
  });

  it('rejects a key that is merely a prefix of the real one', async () => {
    vi.stubEnv('SCHOLARMIND_API_KEY', 'sk-test-1234567890');
    vi.stubEnv('NODE_ENV', 'production');
    const { resolveUser } = await load();
    expect(await resolveUser(new Headers({ 'x-api-key': 'sk-test' }))).toBeNull();
  });

  it('is inert when no key is configured', async () => {
    vi.stubEnv('SCHOLARMIND_API_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    const { resolveUser } = await load();
    expect(await resolveUser(new Headers({ 'x-api-key': '' }))).toBeNull();
    expect(await resolveUser(new Headers())).toBeNull();
  });
});
