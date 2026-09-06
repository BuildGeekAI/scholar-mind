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
    vi.stubEnv('IAP_AUDIENCE', '/projects/1/global/backendServices/2');
    vi.stubEnv('GCS_BUCKET', '');
    await expect(loadEnvModule()).resolves.toBeDefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/GCS_BUCKET/);
    warn.mockRestore();
  });
});
