import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessFacts, Role, aclEnabled, effectiveRole, roleAllows } from '../server/authz';

/**
 * The single most consequential decision in the server. Every other bug here
 * shows up as a broken page; this one shows up as one tenant silently reading
 * another tenant's library, with a 200 and no trace in any log.
 *
 * `effectiveRole` is deliberately a pure function over facts so it can be
 * exhausted without a database. The SQL that gathers those facts is asserted
 * separately in sql.test.ts and exercised for real in tests/integration.
 */

const facts = (over: Partial<AccessFacts> = {}): AccessFacts => ({
  isOwner: false,
  visibility: 'private',
  inOrg: false,
  inTeam: false,
  grants: [],
  ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe('effectiveRole', () => {
  it('gives the owner full rights regardless of anything else', () => {
    expect(effectiveRole(facts({ isOwner: true }))).toBe('owner');
    expect(effectiveRole(facts({ isOwner: true, visibility: 'private', inOrg: false }))).toBe('owner');
  });

  it('grants nothing on a private resource to a stranger', () => {
    expect(effectiveRole(facts({ visibility: 'private', inOrg: true, inTeam: true }))).toBeNull();
  });

  describe('visibility', () => {
    it('makes an org-visible resource readable by org members — the default', () => {
      expect(effectiveRole(facts({ visibility: 'org', inOrg: true }))).toBe('viewer');
    });

    it('does not leak an org-visible resource outside the org', () => {
      expect(effectiveRole(facts({ visibility: 'org', inOrg: false, inTeam: false }))).toBeNull();
    });

    it('makes a team-visible resource readable by team members only', () => {
      expect(effectiveRole(facts({ visibility: 'team', inTeam: true }))).toBe('viewer');
      // In the org but not the team: org membership must not stand in for team.
      expect(effectiveRole(facts({ visibility: 'team', inOrg: true, inTeam: false }))).toBeNull();
    });

    it('never confers write, however widely visible', () => {
      expect(effectiveRole(facts({ visibility: 'org', inOrg: true }))).toBe('viewer');
      expect(effectiveRole(facts({ visibility: 'team', inTeam: true }))).toBe('viewer');
    });
  });

  describe('grants', () => {
    it('reaches a private resource — this is what sharing means', () => {
      expect(effectiveRole(facts({ visibility: 'private', grants: ['viewer'] }))).toBe('viewer');
      expect(effectiveRole(facts({ visibility: 'private', grants: ['editor'] }))).toBe('editor');
    });

    it('is additive: it widens access and can never narrow it', () => {
      // Already a viewer through org visibility; an editor grant lifts them.
      expect(effectiveRole(facts({ visibility: 'org', inOrg: true, grants: ['editor'] }))).toBe('editor');
      // A viewer grant alongside org visibility changes nothing, and removes nothing.
      expect(effectiveRole(facts({ visibility: 'org', inOrg: true, grants: ['viewer'] }))).toBe('viewer');
    });

    it('takes the strongest of several reaching the same person', () => {
      // Direct, via team and via org all collapse into one list by this point.
      expect(effectiveRole(facts({ grants: ['viewer', 'editor', 'viewer'] }))).toBe('editor');
      expect(effectiveRole(facts({ grants: ['editor', 'viewer'] }))).toBe('editor');
    });

    it('does not depend on the order they were collected in', () => {
      const forward = effectiveRole(facts({ grants: ['viewer', 'editor'] }));
      const reverse = effectiveRole(facts({ grants: ['editor', 'viewer'] }));
      expect(forward).toBe(reverse);
    });

    it('honours an explicit owner grant without the resource being owned', () => {
      expect(effectiveRole(facts({ isOwner: false, grants: ['owner'] }))).toBe('owner');
    });
  });

  it('returns null rather than a weak role when nothing applies', () => {
    expect(effectiveRole(facts())).toBeNull();
  });
});

describe('roleAllows', () => {
  const table: Array<[Role | null, 'view' | 'edit' | 'own', boolean]> = [
    ['owner', 'own', true],
    ['owner', 'edit', true],
    ['owner', 'view', true],
    ['editor', 'own', false],
    ['editor', 'edit', true],
    ['editor', 'view', true],
    ['viewer', 'own', false],
    ['viewer', 'edit', false],
    ['viewer', 'view', true],
    [null, 'view', false],
    [null, 'edit', false],
    [null, 'own', false],
  ];

  for (const [role, access, expected] of table) {
    it(`${role ?? 'no role'} ${expected ? 'may' : 'may not'} ${access}`, () => {
      expect(roleAllows(role, access)).toBe(expected);
    });
  }

  it('never lets an editor destroy what they do not own', () => {
    // Ownership is deliberately not grantable: deleting a shared library has to
    // stay with the person whose library it is.
    expect(roleAllows('editor', 'own')).toBe(false);
  });
});

describe('aclEnabled', () => {
  it('is on in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ACL_ENABLED', '');
    expect(aclEnabled()).toBe(true);
  });

  it('is off outside production, as specified for local development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ACL_ENABLED', '');
    expect(aclEnabled()).toBe(false);
  });

  it('can be forced on locally, so the production path is debuggable', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ACL_ENABLED', 'true');
    expect(aclEnabled()).toBe(true);
  });

  it('can be forced off in production only by saying so explicitly', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ACL_ENABLED', 'false');
    expect(aclEnabled()).toBe(false);
  });

  it('ignores values that are not exactly true or false', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ACL_ENABLED', 'yes');
    expect(aclEnabled()).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    expect(aclEnabled()).toBe(false);
  });
});
