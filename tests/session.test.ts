import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainAllowed, isConfigured } from '../server/session';

/**
 * The parts of sign-in that decide things, isolated from the network.
 *
 * `domainAllowed` is the one that matters, and it matters more since sign-in
 * moved to email and password: it is now the only gate between "anyone who can
 * receive email" and "people from your organisation". Profiles default to
 * org-visible, so getting it wrong means a stranger reading someone's library
 * rather than merely seeing a login screen.
 */

afterEach(() => vi.unstubAllEnvs());

describe('domainAllowed', () => {
  it('permits any address when no allowlist is configured', () => {
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
  it('is false until an identity provider is configured', () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    expect(isConfigured()).toBe(false);
    vi.stubEnv('FIREBASE_PROJECT_ID', 'scholar-mind-dev');
    expect(isConfigured()).toBe(true);
  });
});

/**
 * The `*` escape hatch. It exists so a deployment can say "open registration is
 * deliberate" and satisfy the startup guard — if it did not actually open the
 * gate, the guard would be a trap that no value could pass.
 */
describe('open registration', () => {
  it('"*" allows any address', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', '*');
    expect(domainAllowed('anyone@anywhere.example')).toBe(true);
  });

  it('"*" alongside domains still allows everything', () => {
    // Ambiguous input, resolved the permissive way on purpose: someone who
    // wrote '*' meant it, and silently ignoring it would be worse.
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com,*');
    expect(domainAllowed('someone@elsewhere.example')).toBe(true);
  });

  it('does not treat "*" as a literal domain', () => {
    vi.stubEnv('AUTH_ALLOWED_DOMAINS', 'example.com');
    expect(domainAllowed('someone@*')).toBe(false);
  });
});
