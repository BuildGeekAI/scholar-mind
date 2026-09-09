import { afterEach, describe, expect, it, vi } from 'vitest';
import { Access, visibilityPredicate } from '../server/authz';

/**
 * The predicate that carries the authorization decision into every query.
 *
 * These assertions are deliberately about *structure*, not exact text: what
 * matters is which tables a mode consults and which it must not. The one
 * character-level assertion is the parameter discipline below, and it earns its
 * place — that exact bug shipped and broke every request in the ACL-disabled
 * configuration.
 */

const ACCESSES: Access[] = ['view', 'edit', 'own'];

afterEach(() => vi.unstubAllEnvs());

const withAcl = (on: boolean) => {
  vi.stubEnv('ACL_ENABLED', on ? 'true' : 'false');
};

describe('visibilityPredicate with ACLs enforced', () => {
  it('lets the owner through in every mode', () => {
    withAcl(true);
    for (const access of ACCESSES) {
      expect(visibilityPredicate('p', '$1', access)).toContain('p.owner_id = $1');
    }
  });

  describe('view', () => {
    it('consults org membership, team membership and grants', () => {
      withAcl(true);
      const sql = visibilityPredicate('p', '$1', 'view');
      expect(sql).toContain('org_members');
      expect(sql).toContain('team_members');
      expect(sql).toContain('resource_grants');
    });

    it('gates each visibility level on the matching membership', () => {
      withAcl(true);
      const sql = visibilityPredicate('p', '$1', 'view');
      // Org visibility must require org membership, not merely exist.
      expect(sql).toMatch(/p\.visibility = 'org'[\s\S]*?org_members/);
      expect(sql).toMatch(/p\.visibility = 'team'[\s\S]*?team_members/);
    });

    it('accepts any grant role, since all of them imply reading', () => {
      withAcl(true);
      expect(visibilityPredicate('p', '$1', 'view')).toContain(`('viewer','editor','owner')`);
    });
  });

  describe('edit', () => {
    it('never lets visibility confer write', () => {
      withAcl(true);
      const sql = visibilityPredicate('p', '$1', 'edit');
      expect(sql).not.toContain('visibility');
      expect(sql).not.toContain('org_members\n');
    });

    it('accepts only editor and owner grants', () => {
      withAcl(true);
      const sql = visibilityPredicate('p', '$1', 'edit');
      expect(sql).toContain(`('editor','owner')`);
      expect(sql).not.toContain(`('viewer','editor','owner')`);
    });
  });

  describe('own', () => {
    it('is the owner column alone — ownership is not grantable', () => {
      withAcl(true);
      const sql = visibilityPredicate('p', '$1', 'own');
      expect(sql.trim()).toBe('p.owner_id = $1');
      expect(sql).not.toContain('resource_grants');
      expect(sql).not.toContain('visibility');
    });
  });

  it('respects the alias it is given, so it composes into any query', () => {
    withAcl(true);
    const sql = visibilityPredicate('prof', '$3', 'view');
    expect(sql).toContain('prof.owner_id = $3');
    expect(sql).not.toContain('p.owner_id');
  });

  it('scopes grants to the named resource type', () => {
    withAcl(true);
    expect(visibilityPredicate('c', '$1', 'view', 'crawler')).toContain(
      `g.resource_type = 'crawler'`
    );
  });
});

describe('visibilityPredicate with ACLs disabled', () => {
  it('collapses to a condition that is always true', () => {
    withAcl(false);
    for (const access of ACCESSES) {
      expect(visibilityPredicate('p', '$1', access)).toContain('IS NOT NULL');
    }
  });

  it('stops filtering — no membership or grant tables are consulted', () => {
    withAcl(false);
    const sql = visibilityPredicate('p', '$1', 'view');
    expect(sql).not.toContain('org_members');
    expect(sql).not.toContain('team_members');
    expect(sql).not.toContain('resource_grants');
  });

  it('casts the parameter, since there is nothing to infer its type from', () => {
    withAcl(false);
    // Without the cast Postgres answers "could not determine data type of
    // parameter $1" and the whole query fails.
    expect(visibilityPredicate('p', '$1', 'view')).toContain('$1::text');
  });
});

/**
 * The regression that motivated this file.
 *
 * Callers bind the same values whether or not ACLs are on. Postgres rejects a
 * statement whose parameters go unreferenced — "bind message supplies 1
 * parameters, but prepared statement requires 0" — so a predicate that stops
 * mentioning its parameter takes down every query that uses it, in exactly one
 * configuration and therefore in exactly one environment.
 */
describe('parameter discipline', () => {
  for (const enabled of [true, false]) {
    for (const access of ACCESSES) {
      it(`references its user parameter for ${access} with ACLs ${enabled ? 'on' : 'off'}`, () => {
        withAcl(enabled);
        expect(visibilityPredicate('p', '$1', access)).toContain('$1');
      });
    }
  }

  it('references a non-default placeholder too', () => {
    withAcl(false);
    expect(visibilityPredicate('p', '$4', 'view')).toContain('$4');
  });
});
