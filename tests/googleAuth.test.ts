import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainAllowed, isConfigured, redirectUri } from '../server/googleAuth';

/**
 * The parts of sign-in that decide things, isolated from the network.
 *
 * `domainAllowed` is the one that matters: it is the gate between "anyone with
 * a Google account" and "people from your organisation", and profiles default
 * to org-visible, so getting it wrong means a stranger reading someone's
 * library rather than merely seeing a login screen.
 */

afterEach(() => vi.unstubAllEnvs());

describe('domainAllowed', () => {
  it('permits any account when no allowlist is configured', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', '');
    expect(domainAllowed('anyone@gmail.com')).toBe(true);
    expect(domainAllowed('someone@example.org')).toBe(true);
  });

  it('permits only listed domains once an allowlist exists', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    expect(domainAllowed('person@example.com')).toBe(true);
    expect(domainAllowed('person@elsewhere.com')).toBe(false);
  });

  it('accepts a comma-separated list, tolerating spacing', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', ' example.com , example.org ');
    expect(domainAllowed('a@example.com')).toBe(true);
    expect(domainAllowed('b@example.org')).toBe(true);
    expect(domainAllowed('c@example.net')).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'Example.COM');
    expect(domainAllowed('Person@EXAMPLE.com')).toBe(true);
  });

  it('prefers the verified hosted domain over the address', () => {
    // `hd` is asserted by Google for Workspace accounts; the address is merely
    // what the token says it is.
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'corp.example');
    expect(domainAllowed('person@alias.example', 'corp.example')).toBe(true);
    expect(domainAllowed('person@corp.example', 'other.example')).toBe(false);
  });

  it('does not match a domain that merely ends with an allowed one', () => {
    // "notexample.com" must not pass an allowlist of "example.com".
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    expect(domainAllowed('person@notexample.com')).toBe(false);
    expect(domainAllowed('person@example.com.attacker.test')).toBe(false);
  });

  it('does not match a subdomain of an allowed domain', () => {
    // Subdomains are a separate decision; silently including them would widen
    // the gate beyond what was written down.
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    expect(domainAllowed('person@mail.example.com')).toBe(false);
  });

  it('refuses an address with no domain at all', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    expect(domainAllowed('nonsense')).toBe(false);
    expect(domainAllowed('')).toBe(false);
  });
});

describe('isConfigured', () => {
  it('is false until both halves of the OAuth client are set', () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
    expect(isConfigured()).toBe(false);

    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'id');
    expect(isConfigured()).toBe(false);

    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
    expect(isConfigured()).toBe(true);
  });
});

describe('redirectUri', () => {
  it('is built from the origin the browser actually uses', () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'https://scholarmind.example');
    expect(redirectUri()).toBe('https://scholarmind.example/api/auth/callback');
  });

  it('tolerates a trailing slash rather than producing a double one', () => {
    // A double slash would not match the URI registered on the OAuth client,
    // and Google rejects the flow with an error that names nothing useful.
    vi.stubEnv('PUBLIC_ORIGIN', 'https://scholarmind.example/');
    expect(redirectUri()).toBe('https://scholarmind.example/api/auth/callback');
  });

  it('falls back to the local dev origin', () => {
    vi.stubEnv('PUBLIC_ORIGIN', '');
    expect(redirectUri()).toBe('http://localhost:3000/api/auth/callback');
  });
});
