import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The tests that need a real database.
 *
 * Opt-in via TEST_DATABASE_URL — deliberately *not* DATABASE_URL, because this
 * suite drops and recreates the schema and must never be able to do that to a
 * development database that happens to be configured. The name must also end in
 * `_test`, so a mistyped URL fails the guard instead of the data.
 *
 *   createdb scholarmind_test
 *   TEST_DATABASE_URL=postgres://scholarmind:scholarmind@127.0.0.1:5432/scholarmind_test \
 *     npx vitest run tests/integration
 *
 * `npm test` skips the whole file when the variable is absent, so the default
 * suite stays network-free.
 */
const url = process.env.TEST_DATABASE_URL;
const named = !!url && /\/[A-Za-z0-9_]*_test(\?|$)/.test(url);

if (url && !named) {
  throw new Error(
    `TEST_DATABASE_URL must name a database ending in _test (got ${url.replace(/\/\/.*@/, '//…@')}). ` +
      `This suite drops the schema.`
  );
}

const ORG_A = '00000000-0000-0000-0000-0000000000a0';
const ORG_B = '00000000-0000-0000-0000-0000000000b0';
const TEAM_A1 = '00000000-0000-0000-0000-0000000000a1';
const TEAM_A2 = '00000000-0000-0000-0000-0000000000a2';
const TEAM_B1 = '00000000-0000-0000-0000-0000000000b1';
const ALICE = '00000000-0000-0000-0000-00000000a001';
const BOB = '00000000-0000-0000-0000-00000000a002';
const CAROL = '00000000-0000-0000-0000-00000000b001';

describe.skipIf(!url)('multi-tenant access control, against Postgres', () => {
  let db: typeof import('../../server/db');
  let repo: typeof import('../../server/repository');
  let authz: typeof import('../../server/authz');
  let search: typeof import('../../server/search');
  let jobs: typeof import('../../server/jobs');

  const ctxFor = (userId: string, orgId: string, teamId: string) => ({
    userId,
    orgId,
    teamId,
    email: `${userId}@example.com`,
  });

  const alice = () => ctxFor(ALICE, ORG_A, TEAM_A1);
  const bob = () => ctxFor(BOB, ORG_A, TEAM_A2);
  const carol = () => ctxFor(CAROL, ORG_B, TEAM_B1);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    // Enforced, or none of this tests anything.
    process.env.ACL_ENABLED = 'true';

    db = await import('../../server/db');
    const migrate = await import('../../server/db/migrate');
    await migrate.reset();
    await migrate.migrate();

    repo = await import('../../server/repository');
    authz = await import('../../server/authz');
    search = await import('../../server/search');
    jobs = await import('../../server/jobs');

    // Two orgs. Alice and Bob share org A but sit in different teams; Carol is
    // in a different org entirely.
    await db.query(
      `INSERT INTO orgs (id, slug, name) VALUES ($1,'org-a','Org A'), ($2,'org-b','Org B')`,
      [ORG_A, ORG_B]
    );
    await db.query(
      `INSERT INTO teams (id, org_id, slug, name)
       VALUES ($1,$4,'t1','Team One'), ($2,$4,'t2','Team Two'), ($3,$5,'t1','Team B')`,
      [TEAM_A1, TEAM_A2, TEAM_B1, ORG_A, ORG_B]
    );
    await db.query(
      `INSERT INTO users (id, external_id, email)
       VALUES ($1,'alice','alice@example.com'),
              ($2,'bob','bob@example.com'),
              ($3,'carol','carol@example.com')`,
      [ALICE, BOB, CAROL]
    );
    await db.query(
      `INSERT INTO org_members (org_id, user_id)
       VALUES ($1,$3), ($1,$4), ($2,$5)`,
      [ORG_A, ORG_B, ALICE, BOB, CAROL]
    );
    await db.query(
      `INSERT INTO team_members (team_id, user_id)
       VALUES ($1,$4), ($2,$5), ($3,$6)`,
      [TEAM_A1, TEAM_A2, TEAM_B1, ALICE, BOB, CAROL]
    );
  });

  afterAll(async () => {
    await db?.closePool();
    vi.unstubAllEnvs();
  });

  describe('visibility', () => {
    it('makes an org-visible library readable by another member of the org', async () => {
      await repo.createProfile(alice(), { id: 'lib-org', title: 'Org visible', visibility: 'org' });
      expect(await repo.getProfile(bob(), 'lib-org')).not.toBeNull();
    });

    it('does not leak it to a different org', async () => {
      expect(await repo.getProfile(carol(), 'lib-org')).toBeNull();
    });

    it('hides a private library from everyone but its owner', async () => {
      await repo.createProfile(alice(), { id: 'lib-priv', title: 'Private', visibility: 'private' });
      expect(await repo.getProfile(alice(), 'lib-priv')).not.toBeNull();
      expect(await repo.getProfile(bob(), 'lib-priv')).toBeNull();
      expect(await repo.getProfile(carol(), 'lib-priv')).toBeNull();
    });

    it('scopes a team-visible library to the team, not the org', async () => {
      await repo.createProfile(alice(), { id: 'lib-team', title: 'Team', visibility: 'team' });
      // Bob is in the same org but a different team.
      expect(await repo.getProfile(bob(), 'lib-team')).toBeNull();
      expect(await repo.getProfile(alice(), 'lib-team')).not.toBeNull();
    });

    it('lists exactly what each caller may see', async () => {
      const forAlice = (await repo.listProfiles(alice())).map(p => p.id).sort();
      const forBob = (await repo.listProfiles(bob())).map(p => p.id).sort();
      const forCarol = (await repo.listProfiles(carol())).map(p => p.id);
      expect(forAlice).toEqual(['lib-org', 'lib-priv', 'lib-team']);
      expect(forBob).toEqual(['lib-org']);
      expect(forCarol).toEqual([]);
    });
  });

  describe('writes', () => {
    it('refuses a write to a library the caller can only read', async () => {
      expect(await repo.getProfile(bob(), 'lib-org', 'edit')).toBeNull();
      expect(await repo.updateProfile(bob(), 'lib-org', { title: 'Hijacked' })).toBeNull();
      const still = await repo.getProfile(alice(), 'lib-org');
      expect(still!.title).toBe('Org visible');
    });

    it('refuses deletion by anyone but the owner', async () => {
      expect(await repo.deleteProfile(bob(), 'lib-org')).toBe(false);
      expect(await repo.getProfile(alice(), 'lib-org')).not.toBeNull();
    });
  });

  describe('grants', () => {
    it('a viewer grant opens a private library for reading only', async () => {
      await authz.grantAccess(alice(), 'lib-priv', 'user', BOB, 'viewer');
      expect(await repo.getProfile(bob(), 'lib-priv')).not.toBeNull();
      expect(await repo.getProfile(bob(), 'lib-priv', 'edit')).toBeNull();
    });

    it('an editor grant opens it for writing, but not for destroying', async () => {
      await authz.grantAccess(alice(), 'lib-priv', 'user', BOB, 'editor');
      expect(await repo.getProfile(bob(), 'lib-priv', 'edit')).not.toBeNull();
      expect(await repo.getProfile(bob(), 'lib-priv', 'own')).toBeNull();
      expect(await repo.deleteProfile(bob(), 'lib-priv')).toBe(false);
    });

    it('reaches everyone in a team when the grant names the team', async () => {
      await repo.createProfile(alice(), { id: 'lib-tg', title: 'Team granted', visibility: 'private' });
      expect(await repo.getProfile(bob(), 'lib-tg')).toBeNull();
      await authz.grantAccess(alice(), 'lib-tg', 'team', TEAM_A2, 'viewer');
      expect(await repo.getProfile(bob(), 'lib-tg')).not.toBeNull();
      // Carol is in neither the team nor the org.
      expect(await repo.getProfile(carol(), 'lib-tg')).toBeNull();
    });

    it('reaches across orgs when the grant names a person directly', async () => {
      await authz.grantAccess(alice(), 'lib-tg', 'user', CAROL, 'viewer');
      expect(await repo.getProfile(carol(), 'lib-tg')).not.toBeNull();
    });

    it('revoking closes access again', async () => {
      await authz.revokeAccess('lib-tg', 'user', CAROL);
      expect(await repo.getProfile(carol(), 'lib-tg')).toBeNull();
    });

    it('reports the effective role each caller holds', async () => {
      expect(await authz.profileRole(alice(), 'lib-priv')).toBe('owner');
      expect(await authz.profileRole(bob(), 'lib-priv')).toBe('editor');
      expect(await authz.profileRole(carol(), 'lib-priv')).toBeNull();
    });
  });

  describe('search', () => {
    const indexOne = async (profileId: string, paperId: string, text: string) => {
      await repo.upsertPaper(profileId, {
        id: paperId,
        title: `Paper ${paperId}`,
        year: '2020',
        authors: [],
        summary: text,
        status: 'discovered',
      } as any);
      const indexer = await import('../../server/indexer');
      await indexer.indexPaper(profileId, {
        id: paperId,
        title: `Paper ${paperId}`,
        authors: [],
        summary: text,
        status: 'discovered',
      } as any);
    };

    beforeAll(async () => {
      await indexOne('lib-org', 'pub', 'Distinctive marmoset findings in the org-visible library.');
      await indexOne('lib-priv', 'sec', 'Distinctive marmoset findings in the private library.');
    });

    it('finds what the caller may see', async () => {
      const hits = await search.search(bob(), 'marmoset', { scope: 'org' });
      expect(hits.map(h => h.profileId)).toContain('lib-org');
    });

    it('never returns a chunk from a library the caller cannot reach', async () => {
      const hits = await search.search(carol(), 'marmoset', { scope: 'org' });
      expect(hits).toEqual([]);
    });

    it('honours a grant — this is the query File Search could not express', async () => {
      // Bob has an editor grant on lib-priv from the block above.
      const hits = await search.search(bob(), 'marmoset', { scope: 'org' });
      expect(hits.map(h => h.profileId).sort()).toEqual(['lib-org', 'lib-priv']);
    });

    it('runs every scope without a parameter-binding error', async () => {
      // Each scope references a different set of parameters; a scope that binds
      // one it does not use fails outright rather than returning wrong rows.
      for (const scope of ['me', 'team', 'org', 'profile'] as const) {
        await expect(
          search.search(alice(), 'marmoset', { scope, profileId: scope === 'profile' ? 'lib-org' : undefined })
        ).resolves.toBeInstanceOf(Array);
      }
    });

    it('scope=me returns only the caller’s own libraries', async () => {
      const forBob = await search.search(bob(), 'marmoset', { scope: 'me' });
      expect(forBob).toEqual([]);
      const forAlice = await search.search(alice(), 'marmoset', { scope: 'me' });
      expect(forAlice.length).toBeGreaterThan(0);
    });
  });

  describe('the queue', () => {
    it('claims each job exactly once across concurrent workers', async () => {
      const run = await jobs.createRun(alice(), 'lib-org', 'index');
      for (let i = 0; i < 60; i += 1) {
        await jobs.enqueue(alice(), {
          type: 'paper.index',
          runId: run.id,
          payload: { n: i },
          dedupeKey: `claim-test-${i}`,
        });
      }

      const claimed = (
        await Promise.all(Array.from({ length: 10 }, (_, i) => jobs.claim(`worker-${i}`, 6)))
      ).flat();

      expect(claimed).toHaveLength(60);
      expect(new Set(claimed.map(j => j.id)).size).toBe(60);
    });

    it('refuses to queue the same work twice while it is outstanding', async () => {
      const first = await jobs.enqueue(alice(), { type: 'paper.index', dedupeKey: 'dupe-me' });
      const second = await jobs.enqueue(alice(), { type: 'paper.index', dedupeKey: 'dupe-me' });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('allows the same key again once the earlier job has settled', async () => {
      const job = await jobs.enqueue(alice(), { type: 'paper.index', dedupeKey: 'reusable' });
      await jobs.succeed(job!.id);
      const again = await jobs.enqueue(alice(), { type: 'paper.index', dedupeKey: 'reusable' });
      expect(again).not.toBeNull();
    });

    it('requeues a job whose worker stopped heartbeating', async () => {
      // Cleared first: claim() takes the oldest eligible job, so jobs left
      // queued by the tests above would be picked instead of this one.
      await db.query(`DELETE FROM jobs`);
      const job = await jobs.enqueue(alice(), { type: 'paper.index', dedupeKey: 'abandoned' });
      const claimed = await jobs.claim('doomed-worker', 1);
      expect(claimed.map(j => j.id)).toEqual([job!.id]);
      await db.query(
        `UPDATE jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`,
        [job!.id]
      );
      expect(await jobs.reapStale(60)).toBeGreaterThanOrEqual(1);
      const row = await db.one(`SELECT status FROM jobs WHERE id = $1`, [job!.id]);
      expect(row!.status).toBe('queued');
    });

    it('settles a run from its jobs, and never resurrects a cancelled one', async () => {
      const run = await jobs.createRun(alice(), 'lib-org', 'crawl');
      const job = await jobs.enqueue(alice(), {
        type: 'crawl.profile',
        runId: run.id,
        dedupeKey: 'settle-me',
      });
      await jobs.succeed(job!.id);
      expect(await jobs.settleRun(run.id)).toBe('succeeded');

      await jobs.cancelRun(run.id, { duplicate: { id: 'lib-priv' } });
      // A late settle from another worker must not undo the cancellation.
      await jobs.settleRun(run.id);
      const after = await jobs.getRun(run.id);
      expect(after!.status).toBe('cancelled');
      expect(after!.detail.duplicate).toEqual({ id: 'lib-priv' });
    });
  });

  describe('API keys', () => {
    let keys: typeof import('../../server/apiKeys');
    let identity: typeof import('../../server/identity');

    beforeAll(async () => {
      keys = await import('../../server/apiKeys');
      identity = await import('../../server/identity');
    });

    const present = (key: string) => new Headers({ 'x-api-key': key });

    it('resolves to its owner, not to a shared API identity', async () => {
      const { key } = await keys.createKey(ALICE, ORG_A, 'alice laptop', 'write');
      const user = await identity.resolveUser(present(key));
      expect(user?.email).toBe('alice@example.com');
      expect(user?.scope).toBe('write');
      expect(user?.viaKey).toBe(true);
    });

    it('gives two people genuinely different identities', async () => {
      const a = await keys.createKey(ALICE, ORG_A, 'a', 'read');
      const b = await keys.createKey(BOB, ORG_A, 'b', 'read');
      const [ua, ub] = await Promise.all([
        identity.resolveUser(present(a.key)),
        identity.resolveUser(present(b.key)),
      ]);
      expect(ua?.email).toBe('alice@example.com');
      expect(ub?.email).toBe('bob@example.com');
    });

    it('refuses a key whose secret is wrong, even with a valid prefix', async () => {
      const { key } = await keys.createKey(ALICE, ORG_A, 'tamper', 'read');
      const tampered = `${key.slice(0, -2)}00`;
      expect(await keys.verifyKey(tampered)).toBeNull();
    });

    it('refuses an unknown prefix without saying so differently', async () => {
      expect(await keys.verifyKey(`sm_ffffffffffff_${'a'.repeat(48)}`)).toBeNull();
    });

    it('stops working the moment it is revoked', async () => {
      const minted = await keys.createKey(ALICE, ORG_A, 'short-lived', 'read');
      expect(await keys.verifyKey(minted.key)).not.toBeNull();
      expect(await keys.revokeKey(ALICE, minted.record.id)).toBe(true);
      expect(await keys.verifyKey(minted.key)).toBeNull();
    });

    it('cannot be revoked by someone else', async () => {
      const minted = await keys.createKey(ALICE, ORG_A, 'alices', 'read');
      expect(await keys.revokeKey(BOB, minted.record.id)).toBe(false);
      expect(await keys.verifyKey(minted.key)).not.toBeNull();
    });

    it('refuses a key that has expired', async () => {
      const minted = await keys.createKey(ALICE, ORG_A, 'expired', 'read');
      await db.query(`UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1`, [
        minted.record.id,
      ]);
      expect(await keys.verifyKey(minted.key)).toBeNull();
    });

    it('stores only a hash — the database never holds a usable key', async () => {
      const minted = await keys.createKey(ALICE, ORG_A, 'stored', 'read');
      const row = await db.one(`SELECT hash FROM api_keys WHERE id = $1`, [minted.record.id]);
      expect(row!.hash).not.toBe(minted.key);
      expect(row!.hash).toBe(keys.hashKey(minted.key));
      expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('lists live keys and hides revoked ones', async () => {
      const before = await keys.listKeys(ALICE);
      const minted = await keys.createKey(ALICE, ORG_A, 'listed', 'read');
      expect((await keys.listKeys(ALICE)).map(k => k.id)).toContain(minted.record.id);
      await keys.revokeKey(ALICE, minted.record.id);
      const after = await keys.listKeys(ALICE);
      expect(after.map(k => k.id)).not.toContain(minted.record.id);
      expect(after).toHaveLength(before.length);
    });

    it('a key sees exactly what its owner sees, and nothing more', async () => {
      // Alice owns lib-priv; Bob reaches it only through the editor grant.
      const { key } = await keys.createKey(CAROL, ORG_B, 'carol', 'read');
      const user = await identity.resolveUser(present(key));
      const { resolveContext } = await import('../../server/tenancy');
      const ctx = await resolveContext(user!);
      // Carol is in another org with no grants: her key reaches nothing of Alice's.
      expect(await repo.getProfile(ctx, 'lib-priv')).toBeNull();
      expect(await repo.getProfile(ctx, 'lib-org')).toBeNull();
    });
  });

  describe('sessions', () => {
    let auth: typeof import('../../server/session');
    let identity: typeof import('../../server/identity');

    beforeAll(async () => {
      auth = await import('../../server/session');
      identity = await import('../../server/identity');
    });

    const withCookie = (token: string) => new Headers({ cookie: `sm_session=${token}` });

    const google = (subject: string, email: string) => ({
      provider: 'firebase',
      subject,
      email,
      name: 'Signed In',
      picture: undefined,
    });

    it('creates the person on first sign-in and resolves them afterwards', async () => {
      const { token, user } = await auth.signIn(google('11111', 'newcomer@example.com'));
      expect(user.email).toBe('newcomer@example.com');
      const resolved = await identity.resolveUser(withCookie(token));
      expect(resolved?.email).toBe('newcomer@example.com');
      expect(resolved?.viaKey).toBeFalsy();
    });

    it('keys the person on the provider subject, so a changed address is the same person', async () => {
      const first = await auth.signIn(google('22222', 'before@example.com'));
      const second = await auth.signIn(google('22222', 'after@example.com'));
      expect(second.user.userId).toBe(first.user.userId);
      // And the newer address wins.
      expect(second.user.email).toBe('after@example.com');
    });

    /**
     * The provider re-issues an id for the same person — an account deleted and
     * re-created, or a move between providers. The address is unique by design,
     * so a naive insert violates the index and sign-in fails with an opaque 500.
     * The person must keep their libraries.
     */
    it('adopts the existing person when a new subject brings a known address', async () => {
      const first = await auth.signIn(google('adopt-1', 'adopted@example.com'));

      // Something owned by this person before the provider changed its mind.
      await repo.createProfile(
        { userId: first.user.userId, orgId: ORG_A, teamId: TEAM_A1, email: 'adopted@example.com' },
        { id: 'kept-library', title: 'Kept' }
      );

      const second = await auth.signIn(google('adopt-2', 'adopted@example.com'));
      expect(second.user.userId).toBe(first.user.userId);

      const ctx = {
        userId: second.user.userId,
        orgId: ORG_A,
        teamId: TEAM_A1,
        email: 'adopted@example.com',
      };
      expect(await repo.getProfile(ctx, 'kept-library')).not.toBeNull();
    });

    it('leaves one row per address, so sharing by email stays unambiguous', async () => {
      await auth.signIn(google('unique-1', 'onlyone@example.com'));
      await auth.signIn(google('unique-2', 'onlyone@example.com'));
      const row = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM users WHERE lower(email) = 'onlyone@example.com'`
      );
      expect(Number(row!.n)).toBe(1);
    });

    it('rejects a forged cookie of the right shape', async () => {
      expect(await auth.verifySession('a'.repeat(64))).toBeNull();
    });

    it('rejects a cookie of the wrong shape without touching the database', async () => {
      expect(await auth.verifySession('not-a-token')).toBeNull();
      expect(await auth.verifySession('')).toBeNull();
    });

    it('stops working the moment the session is signed out', async () => {
      const { token } = await auth.signIn(google('33333', 'bye@example.com'));
      expect(await auth.verifySession(token)).not.toBeNull();
      await auth.signOut(token);
      expect(await auth.verifySession(token)).toBeNull();
    });

    it('rejects an expired session', async () => {
      const { token } = await auth.signIn(google('44444', 'stale@example.com'));
      await db.query(
        `UPDATE sessions SET expires_at = now() - interval '1 day' WHERE token_hash = $1`,
        [require('node:crypto').createHash('sha256').update(token).digest('hex')]
      );
      expect(await auth.verifySession(token)).toBeNull();
    });

    it('stores only a hash — the database never holds a usable cookie', async () => {
      const { token } = await auth.signIn(google('55555', 'hashed@example.com'));
      const row = await db.one(`SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1`);
      expect(row!.token_hash).not.toBe(token);
      expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signing out one session leaves the others alone', async () => {
      const laptop = await auth.signIn(google('66666', 'two@example.com'));
      const phone = await auth.signIn(google('66666', 'two@example.com'));
      await auth.signOut(laptop.token);
      expect(await auth.verifySession(laptop.token)).toBeNull();
      expect(await auth.verifySession(phone.token)).not.toBeNull();
    });

    it('a signed-in person lands in a tenant and can hold libraries', async () => {
      const { token } = await auth.signIn(google('77777', 'tenant@example.com'));
      const user = await identity.resolveUser(withCookie(token));
      const { resolveContext } = await import('../../server/tenancy');
      const ctx = await resolveContext(user!);
      expect(ctx.orgId).toBeTruthy();
      expect(ctx.teamId).toBeTruthy();
      // New person, no grants: they see nothing of Alice's private library.
      expect(await repo.getProfile(ctx, 'lib-priv')).toBeNull();
    });

    it('purges expired sessions and leaves live ones', async () => {
      const live = await auth.signIn(google('88888', 'live@example.com'));
      await db.query(`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE user_id <> $1`, [
        live.user.userId,
      ]);
      await auth.purgeExpiredSessions();
      expect(await auth.verifySession(live.token)).not.toBeNull();
    });
  });

  describe('degradation', () => {
    /**
     * The search index must not depend on File Search being reachable. It exists
     * precisely because File Search cannot answer an ACL-scoped query, so an
     * expired key emptying it would be the worst possible coupling — and it is
     * exactly what happened before this was pinned: the job aborted on store
     * creation and the paper never reached Postgres at all.
     *
     * There is no GEMINI_API_KEY in this suite, so every Gemini call genuinely
     * fails. That is the condition under test, not a limitation of it.
     */
    it('indexes a paper for search even when every Gemini call fails', async () => {
      const { processPaper } = await import('../../server/ingest');
      const { createBlobStore } = await import('../../server/blobStore');

      await repo.createProfile(alice(), { id: 'lib-degraded', title: 'Degraded' });
      const paper: any = {
        id: 'd1',
        title: 'Degraded paper',
        authors: ['Author'],
        year: '2021',
        summary: 'A singular capybara census conducted without any working API key.',
        status: 'discovered',
      };
      await repo.upsertPaper('lib-degraded', paper);

      // No store, because none could be created.
      const result = await processPaper('lib-degraded', paper, createBlobStore(), undefined, 'index');

      expect(result.indexStatus).toBe('indexed');
      const hits = await search.search(alice(), 'capybara', { scope: 'me' });
      expect(hits.map(h => h.paperId)).toContain('d1');
    });

    it('reports the failed download without failing the paper', async () => {
      const back = await repo.getPaper('lib-degraded', 'd1');
      // Resolution could not run, so there is no PDF — but the paper indexed.
      expect(back!.indexStatus).toBe('indexed');
      expect(back!.pdfKey).toBeUndefined();
    });
  });

  describe('advisors', () => {
    let advisorModule: typeof import('../../server/advisor');
    let indexer: typeof import('../../server/indexer');

    const paperFor = (id: string, title: string, text: string): any => ({
      id,
      title,
      authors: ['Author'],
      year: '1905',
      summary: text,
      status: 'discovered',
    });

    beforeAll(async () => {
      advisorModule = await import('../../server/advisor');
      indexer = await import('../../server/indexer');

      // Alice publishes an advisor to the org; Bob keeps one private.
      await repo.createProfile(alice(), {
        id: 'adv-shared',
        title: 'Einstein',
        visibility: 'org',
        advisorEnabled: true,
        advisorName: 'Albert Einstein',
      });
      await repo.createProfile(bob(), {
        id: 'adv-private',
        title: 'Private advisor',
        visibility: 'private',
        advisorEnabled: true,
        advisorName: 'Someone Private',
      });

      for (const [profileId, id, text] of [
        ['adv-shared', 'e1', 'The luminiferous ether will prove superfluous in this framework.'],
        ['adv-private', 'x1', 'The luminiferous ether appears here too, but privately.'],
      ] as const) {
        const paper = paperFor(id, `Paper ${id}`, text);
        await repo.upsertPaper(profileId, paper);
        await indexer.indexPaper(profileId, paper);
      }
    });

    it('lists an advisor shared with you alongside your own', async () => {
      const forBob = await repo.listAdvisors(bob());
      const ids = forBob.map(a => a.id);
      expect(ids).toContain('adv-shared'); // Alice's, org-visible
      expect(ids).toContain('adv-private'); // Bob's own
    });

    it('does not list an advisor that is private to someone else', async () => {
      const forAlice = await repo.listAdvisors(alice());
      expect(forAlice.map(a => a.id)).not.toContain('adv-private');
    });

    it('does not list advisors to another org at all', async () => {
      expect(await repo.listAdvisors(carol())).toEqual([]);
    });

    it('counts indexed documents, not papers — an unindexed paper is unanswerable', async () => {
      await repo.upsertPaper('adv-shared', paperFor('unindexed', 'Never indexed', 'nothing'));
      const advisor = (await repo.listAdvisors(alice())).find(a => a.id === 'adv-shared');
      const papers = await repo.listPapers('adv-shared');
      expect(papers.length).toBeGreaterThan(advisor!.indexedCount);
      expect(advisor!.indexedCount).toBe(1);
    });

    it('reports whether an advisor is yours', async () => {
      const forBob = await repo.listAdvisors(bob());
      expect(forBob.find(a => a.id === 'adv-private')!.mine).toBe(true);
      expect(forBob.find(a => a.id === 'adv-shared')!.mine).toBe(false);
    });

    it('retrieves only from the advisor asked, never from a neighbour', async () => {
      // Both libraries contain the phrase; scoping must keep them apart.
      const shared = await repo.getProfile(bob(), 'adv-shared');
      const answer = await advisorModule.askAdvisor(bob(), shared!, 'luminiferous ether');
      expect(answer.citations.length).toBeGreaterThan(0);
      for (const citation of answer.citations) {
        expect(citation.profileId).toBe('adv-shared');
      }
    });

    it('abstains without a model call when nothing relevant is indexed', async () => {
      const shared = await repo.getProfile(alice(), 'adv-shared');
      const answer = await advisorModule.askAdvisor(
        alice(),
        shared!,
        'zzz unrelated sourdough baking technique'
      );
      expect(answer.abstained).toBe(true);
      expect(answer.citations).toEqual([]);
      expect(answer.answer).toMatch(/does not|Nothing in/i);
    });

    it('every citation corresponds to a passage that was retrieved', async () => {
      const shared = await repo.getProfile(alice(), 'adv-shared');
      const answer = await advisorModule.askAdvisor(alice(), shared!, 'luminiferous ether');
      const hits = await search.search(alice(), 'luminiferous ether', {
        scope: 'profile',
        profileId: 'adv-shared',
      });
      const retrieved = new Set(hits.map(h => h.paperId));
      for (const citation of answer.citations) {
        expect(retrieved.has(citation.paperId)).toBe(true);
      }
    });

    it('never throws, so one advisor cannot abort a panel', async () => {
      const shared = await repo.getProfile(alice(), 'adv-shared');
      // No GEMINI_API_KEY in this suite, so the model call genuinely fails.
      await expect(advisorModule.askAdvisor(alice(), shared!, 'ether')).resolves.toMatchObject({
        profileId: 'adv-shared',
      });
    });

    it('consults more than five advisors — the case File Search cannot do', async () => {
      // Six libraries is where File Search returns 400. This path has no such
      // limit; the ceiling is cost, and cost is configurable.
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const id = `panel-${i}`;
        await repo.createProfile(alice(), {
          id,
          title: `Advisor ${i}`,
          advisorEnabled: true,
          advisorName: `Advisor ${i}`,
        });
        const paper = paperFor(`p${i}`, `Paper ${i}`, `Distinctive quokka finding number ${i}.`);
        await repo.upsertPaper(id, paper);
        await indexer.indexPaper(id, paper);
        ids.push(id);
      }

      const profiles = await Promise.all(ids.map(id => repo.getProfile(alice(), id)));
      const answers = await advisorModule.pooled(
        profiles.map(p => () => advisorModule.askAdvisor(alice(), p!, 'quokka')),
        3
      );

      expect(answers).toHaveLength(6);
      // Each drew on its own library and nobody else's.
      for (let i = 0; i < 6; i += 1) {
        expect(answers[i].profileId).toBe(`panel-${i}`);
        for (const citation of answers[i].citations) {
          expect(citation.profileId).toBe(`panel-${i}`);
        }
      }
    });
  });

  describe('retrieval for questions, not search boxes', () => {
    /**
     * The bug that made advisors unusable.
     *
     * `websearch_to_tsquery` ANDs every term, which is right for a search box
     * and catastrophic for a question: "what do you think about overfitting"
     * requires a chunk containing *think*, and no paper contains "think". Four
     * of five natural questions returned nothing, so advisors abstained on
     * almost everything and read as broken.
     */
    beforeAll(async () => {
      const indexer = await import('../../server/indexer');
      await repo.createProfile(alice(), { id: 'nlq', title: 'Natural language questions' });
      const paper: any = {
        id: 'bp',
        title: 'Learning Representations by Back-Propagating Errors',
        authors: ['Rumelhart'],
        year: '1986',
        summary:
          'We describe a new learning procedure, back-propagation, for networks of neurone-like units. ' +
          'The procedure repeatedly adjusts the weights of the connections in the network so as to ' +
          'minimize a measure of the difference between the actual output vector and the desired output.',
        status: 'discovered',
      };
      await repo.upsertPaper('nlq', paper);
      await indexer.indexPaper('nlq', paper);
    });

    const ask = (question: string) =>
      search.search(alice(), question, { scope: 'profile', profileId: 'nlq' });

    it('finds the passage when the question is phrased conversationally', async () => {
      // Every one of these returned zero under AND semantics.
      for (const question of [
        'How do you train a network to minimize error?',
        'What do you think about adjusting connection weights?',
        'Tell me about your work on learning procedures',
      ]) {
        const hits = await ask(question);
        expect(hits.length, question).toBeGreaterThan(0);
      }
    });

    it('still finds nothing for a genuinely unrelated question', async () => {
      // The abstain guard depends on this: OR retrieval must not match
      // everything, or an advisor answers confidently from nothing.
      expect(await ask('How should I bake sourdough bread?')).toEqual([]);
    });

    it('ranks a passage matching more of the question higher', async () => {
      const indexer = await import('../../server/indexer');
      const other: any = {
        id: 'unrelated',
        title: 'A paper about weights only',
        authors: [],
        summary: 'Weights are discussed here and nothing else is.',
        status: 'discovered',
      };
      await repo.upsertPaper('nlq', other);
      await indexer.indexPaper('nlq', other);

      const hits = await ask('learning procedure that adjusts weights to minimize output error');
      expect(hits.length).toBeGreaterThan(1);
      expect(hits[0].paperId).toBe('bp');
    });

    it('treats a question of pure stopwords as no match, not an error', async () => {
      await expect(ask('what is the of and a')).resolves.toEqual([]);
      await expect(ask('   ')).resolves.toEqual([]);
    });

    it('is not confused by tsquery operators typed into a question', async () => {
      // The question is lexemised before being rebuilt, so & | ! ( ) are text.
      await expect(ask('what about weights & networks | (error)!')).resolves.toBeInstanceOf(Array);
    });
  });

  describe('advisor depth', () => {
    it('reports how many sources hold more than an abstract', async () => {
      const indexer = await import('../../server/indexer');
      await repo.createProfile(alice(), {
        id: 'depth',
        title: 'Depth',
        advisorEnabled: true,
        advisorName: 'Thin Advisor',
      });

      const thin: any = { id: 't1', title: 'Abstract only', authors: [], summary: 'One sentence.', status: 'discovered' };
      const deep: any = { id: 't2', title: 'Full text', authors: [], summary: 'One sentence.',
                          extractedText: 'A great deal of actual content lives here.', status: 'discovered' };
      for (const p of [thin, deep]) {
        await repo.upsertPaper('depth', p);
        await indexer.indexPaper('depth', p);
      }

      const advisor = (await repo.listAdvisors(alice())).find(a => a.id === 'depth');
      expect(advisor!.indexedCount).toBe(2);
      expect(advisor!.deepCount).toBe(1);
    });

    it('indexes a paper’s extracted text, not just its abstract', async () => {
      const indexer = await import('../../server/indexer');
      const paper: any = {
        id: 'extracted',
        title: 'Has full text',
        authors: [],
        summary: 'Short abstract.',
        extractedText: 'Distinctive quetzal passage that appears only in the full text.',
        status: 'discovered',
      };
      await repo.upsertPaper('depth', paper);
      await indexer.indexPaper('depth', paper);

      const hits = await search.search(alice(), 'quetzal', { scope: 'profile', profileId: 'depth' });
      expect(hits.map(h => h.paperId)).toContain('extracted');
    });
  });

  describe('consultations', () => {
    it('stores a consultation and reads it back with its citations', async () => {
      const id = await repo.saveConsultation(
        alice(),
        'What of the ether?',
        [
          {
            profileId: 'adv-shared',
            advisorName: 'Albert Einstein',
            answer: 'Superfluous.',
            citations: [{ paperId: 'e1', paperTitle: 'Paper e1', profileId: 'adv-shared', snippet: 's' }],
          },
        ],
        'They agree.'
      );

      const back = await repo.getConsultation(alice(), id);
      expect(back!.question).toBe('What of the ether?');
      expect(back!.synthesis).toBe('They agree.');
      expect(back!.answers).toHaveLength(1);
      expect(back!.answers[0].citations).toHaveLength(1);
    });

    it('is private to whoever asked', async () => {
      const id = await repo.saveConsultation(alice(), 'mine alone', [], undefined);
      expect(await repo.getConsultation(bob(), id)).toBeNull();
      expect((await repo.listConsultations(bob())).map(c => c.id)).not.toContain(id);
    });

    /**
     * The one that matters: a stored answer must not become a way to keep
     * reading an advisor whose owner has since taken it back.
     */
    it('hides an answer once its advisor is no longer shared', async () => {
      await repo.createProfile(alice(), {
        id: 'adv-revoked',
        title: 'Revocable',
        visibility: 'org',
        advisorEnabled: true,
        advisorName: 'Revocable Advisor',
      });

      const id = await repo.saveConsultation(bob(), 'while shared', [
        {
          profileId: 'adv-revoked',
          advisorName: 'Revocable Advisor',
          answer: 'Something Bob could read at the time.',
          citations: [],
        },
      ]);

      expect((await repo.getConsultation(bob(), id))!.answers[0].answer).toContain('at the time');

      await repo.updateProfile(alice(), 'adv-revoked', { visibility: 'private' });

      const after = await repo.getConsultation(bob(), id);
      expect(after!.answers[0].hidden).toBe(true);
      expect(after!.answers[0].answer).not.toContain('at the time');
      expect(after!.answers[0].citations).toEqual([]);
    });
  });

  describe('cascades', () => {
    it('takes papers, messages and indexed chunks with the profile', async () => {
      await repo.createProfile(alice(), { id: 'lib-gone', title: 'Doomed' });
      await repo.upsertPaper('lib-gone', {
        id: 'x',
        title: 'Doomed paper',
        authors: [],
        status: 'discovered',
      } as any);
      await repo.appendMessage('lib-gone', {
        id: 'm',
        role: 'user',
        content: 'hi',
        timestamp: 1,
      });
      const indexer = await import('../../server/indexer');
      await indexer.indexPaper('lib-gone', {
        id: 'x',
        title: 'Doomed paper',
        authors: [],
        summary: 'some text to chunk',
        status: 'discovered',
      } as any);

      expect(await repo.deleteProfile(alice(), 'lib-gone')).toBe(true);
      expect(await repo.listPapers('lib-gone')).toEqual([]);
      expect(await repo.listMessages('lib-gone')).toEqual([]);
      const chunks = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE d.profile_id = 'lib-gone'`
      );
      expect(Number(chunks!.n)).toBe(0);
    });
  });

  describe('round-tripping a paper', () => {
    it('preserves every field, including the JSON ones', async () => {
      const paper: any = {
        id: 'rt',
        kind: 'paper',
        title: 'Round trip',
        year: '2019',
        authors: ['A', 'B'],
        summary: 'S',
        status: 'converted',
        slides: [{ title: 'One', points: ['a', 'b'] }],
        quiz: [{ question: 'q', options: ['1', '2'], correctAnswer: 0, explanation: 'e' }],
        flashCards: [{ front: 'f', back: 'b' }],
        citationMeta: { doi: '10.1/x', volume: '3' },
        pdfStatus: 'fetched',
        indexStatus: 'indexed',
        durationSeconds: 12.5,
      };
      await repo.upsertPaper('lib-org', paper);
      const back = await repo.getPaper('lib-org', 'rt');
      expect(back).toMatchObject(paper);
    });

    it('clears a field that is no longer set — the Firestore workaround is gone', async () => {
      await repo.upsertPaper('lib-org', {
        id: 'rt',
        title: 'Round trip',
        authors: [],
        status: 'converted',
        stage: 'indexing',
      } as any);
      expect((await repo.getPaper('lib-org', 'rt'))!.stage).toBe('indexing');

      await repo.upsertPaper('lib-org', {
        id: 'rt',
        title: 'Round trip',
        authors: [],
        status: 'converted',
        stage: undefined,
      } as any);
      expect((await repo.getPaper('lib-org', 'rt'))!.stage).toBeUndefined();
    });
  });
});
