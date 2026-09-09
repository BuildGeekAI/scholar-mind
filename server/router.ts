import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LegacyProfile, Message, Paper } from '../types';
import { cookie, resolveUser, User } from './identity';
import { KeyScope, createKey, listKeys, revokeKey } from './apiKeys';
import { Ctx, PrincipalType, Role, aclEnabled, findUserByEmail, grantAccess, listGrants, profileRole, revokeAccess } from './authz';
import { resolveContext, listOrgUsers } from './tenancy';
import { ping as pingDatabase } from './db';
import * as jobs from './jobs';
import { removePaperFromIndex } from './indexer';
import { Scope, search } from './search';
import {
  AdvisorAnswer,
  advisorName,
  askAdvisor,
  maxPanel,
  panelConcurrency,
  pooled,
  synthesise,
  systemPrompt,
} from './advisor';
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  authorizationUrl,
  domainAllowed,
  exchangeCode,
  isConfigured as googleAuthConfigured,
  randomToken,
  redirectUri,
  signIn,
  signOut,
} from './googleAuth';
import {
  deleteCrawler,
  getCrawler,
  listCrawlers,
  updateCrawler,
  upsertCrawler,
} from './crawler';
import { blobKey, createBlobStore, profilePrefix } from './blobStore';
import * as repo from './repository';
import { createStore, deleteDocument, deleteStore } from './fileSearch';
import { scholarKey, scholarKeysFor } from './corpus';
import {
  detectKind,
  extractFromUpload,
  extractFromUrl,
  isSupportedUpload,
  kindForMime,
} from './sources';
import { PipelineMode } from './ingest';
import { buildProfileZip, pcmToWav } from './export';
import {
  CitationStyle,
  STYLES,
  formatBibliography,
  formatCitation,
  lookupCitationMeta,
} from './citations';
import {
  ask,
  extractText,
  fileSearchTool,
  findCitingPapers,
  generateAudio,
  findSinglePaper,
  googleSearchTool,
  MODELS,
  ai,
} from './gemini';

type Env = { Variables: { user: User; ctx: Ctx } };

const blobs = createBlobStore();

/**
 * File Search accepts at most five stores in one call — six returns
 * `400 Invalid input received`. Measured, not documented.
 */
const MAX_ATTACHED_STORES = 5;

/** Legacy inline artifacts carry no mime type, so recover it from the magic bytes. */
const sniffImageMime = (data: Buffer): string => {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  return 'application/octet-stream';
};

export const createRouter = () => {
  const app = new Hono<Env>().basePath('/api');

  app.get('/healthz', async c => {
    const database = await pingDatabase();
    return c.json(
      {
        ok: database,
        geminiKey: process.env.GEMINI_API_KEY ? 'configured' : 'MISSING',
        database: database ? 'reachable' : 'UNREACHABLE',
        acl: aclEnabled() ? 'enforced' : 'disabled',
        blobs: process.env.GCS_BUCKET ? 'gcs' : 'filesystem',
      },
      database ? 200 : 503
    );
  });

  // --- Google sign-in ------------------------------------------------------
  // Replaces IAP. IAP gates on GCP IAM, so every user needs a role grant in the
  // project — which cannot deliver self-serve signup, and needs a Load Balancer
  // and certificates in front of Cloud Run to exist at all.
  //
  // Registered before the auth middleware, because these are the endpoints an
  // unauthenticated caller has to be able to reach.

  const secureCookie = process.env.NODE_ENV === 'production';

  const setCookie = (c: any, name: string, value: string, maxAgeSeconds: number) => {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      // Lax, not Strict: the OAuth callback is a top-level navigation *from
      // Google*, and Strict would withhold the cookie exactly then.
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secureCookie) parts.push('Secure');
    c.header('Set-Cookie', parts.join('; '), { append: true });
  };

  const clearCookie = (c: any, name: string) => setCookie(c, name, '', 0);

  app.get('/auth/config', c =>
    c.json({ google: googleAuthConfigured(), redirectUri: redirectUri() })
  );

  app.get('/auth/google', c => {
    if (!googleAuthConfigured()) {
      return c.json(
        { error: 'Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID and _SECRET.' },
        503
      );
    }
    // The state parameter, echoed back by Google and compared on return. Without
    // it, an attacker can complete a sign-in flow they started in a victim's
    // browser and leave them logged in as someone else.
    const state = randomToken();
    setCookie(c, STATE_COOKIE, state, 600);
    return c.redirect(authorizationUrl(state));
  });

  app.get('/auth/callback', async c => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const expected = cookie(c.req.raw.headers, STATE_COOKIE);
    clearCookie(c, STATE_COOKIE);

    if (c.req.query('error')) return c.redirect('/?auth=denied');
    if (!code || !state || !expected || state !== expected) return c.redirect('/?auth=state');

    const identity = await exchangeCode(code);
    if (!identity) return c.redirect('/?auth=failed');

    if (!domainAllowed(identity.email, identity.hostedDomain)) {
      return c.redirect('/?auth=domain');
    }

    const { token } = await signIn(identity, c.req.header('user-agent'));
    setCookie(c, SESSION_COOKIE, token, 60 * 60 * 24 * Number(process.env.SESSION_DAYS || 30));
    return c.redirect('/');
  });

  app.post('/auth/signout', async c => {
    await signOut(cookie(c.req.raw.headers, SESSION_COOKIE));
    clearCookie(c, SESSION_COOKIE);
    return c.json({ ok: true });
  });

  app.use('*', async (c, next) => {
    if (c.req.path === '/api/healthz') return next();
    const user = await resolveUser(c.req.raw.headers);
    if (!user) return c.json({ error: 'Unauthenticated' }, 401);
    c.set('user', user);
    // Who they are and which tenant they act in are separate questions; the
    // second needs the database, so it happens here rather than in identity.ts.
    c.set('ctx', await resolveContext(user));
    await next();
  });

  /**
   * A read-only key may only make calls that do not change anything.
   *
   * Enforced by method, with two exceptions: chat and speech are POSTs because
   * they carry a body, not because they write. Everything else that is a POST,
   * PUT, PATCH or DELETE is refused — which is the point of handing someone a
   * read key at all.
   */
  const READ_SAFE_POSTS = new Set(['/api/chat', '/api/tts']);

  app.use('*', async (c, next) => {
    const user = c.get('user');
    if (user?.scope !== 'read') return next();

    const method = c.req.method.toUpperCase();
    const safe =
      method === 'GET' ||
      method === 'HEAD' ||
      method === 'OPTIONS' ||
      (method === 'POST' && READ_SAFE_POSTS.has(c.req.path));

    if (!safe) {
      return c.json(
        { error: 'This API key is read-only. Mint a key with write scope to make changes.' },
        403
      );
    }
    return next();
  });

  /**
   * Loading a profile *is* the authorization check: the predicate is part of the
   * query, so an unreachable profile is indistinguishable from a missing one and
   * both answer 404. Three levels, because they are genuinely different rights:
   * a viewer may read a shared library, an editor may add to it, and only the
   * owner may destroy it — ownership is not grantable.
   */
  const viewable = (c: any, id: string) => repo.getProfile(c.get('ctx'), id, 'view');
  const editable = (c: any, id: string) => repo.getProfile(c.get('ctx'), id, 'edit');
  const ownedOnly = (c: any, id: string) => repo.getProfile(c.get('ctx'), id, 'own');

  // --- Profiles -----------------------------------------------------------
  app.get('/profiles', async c => c.json(await repo.listProfiles(c.get('ctx'))));

  /**
   * The landing page's search. Answers "do I already have this?" before any
   * model call, so arriving with a scholar in mind lands in their library
   * rather than building a second one.
   */
  app.get('/discover', async c => {
    const q = (c.req.query('q') || '').trim();
    if (!q) return c.json({ query: '', matches: [] });

    const key = scholarKey(q);
    const needle = q.toLowerCase();
    const profiles = await repo.listProfiles(c.get('ctx'));

    const scored = await Promise.all(
      profiles.map(async p => {
        const keys = p.scholarKeys ?? [];
        const exact = !!key && keys.includes(key);
        const named =
          (p.scholarName || '').toLowerCase().includes(needle) ||
          (p.title || '').toLowerCase().includes(needle) ||
          (p.topics || []).some(t => t.toLowerCase().includes(needle));
        if (!exact && !named) return null;

        const papers = await repo.listPapers(p.id);
        return {
          id: p.id,
          title: p.title,
          emoji: p.emoji,
          scholarName: p.scholarName,
          affiliation: p.affiliation,
          topics: p.topics ?? [],
          sourceCount: papers.length,
          indexedCount: papers.filter(x => x.fileSearchDocName).length,
          updatedAt: p.updatedAt,
          // An exact identity match is offered as "this is it", a name
          // substring only as "you might mean".
          exact,
        };
      })
    );

    const matches = scored
      .filter((m): m is NonNullable<typeof m> => !!m)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.updatedAt - a.updatedAt);

    return c.json({ query: q, matches });
  });

  app.post('/profiles', async c => {
    const body = await c.req.json().catch(() => ({}));
    const created = await repo.createProfile(c.get('ctx'), {
      id: body.id || crypto.randomUUID(),
      title: body.title,
      emoji: body.emoji,
      theme: body.theme,
    });
    // Per-profile retrieval store; absence is tolerated and simply disables RAG.
    const fileSearchStoreName = await createStore(created.title);
    if (fileSearchStoreName) {
      await repo.updateProfile(c.get('ctx'), created.id, { fileSearchStoreName });
      created.fileSearchStoreName = fileSearchStoreName;
    }
    return c.json(created, 201);
  });

  app.get('/profiles/:id', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const [papers, messages] = await Promise.all([
      repo.listPapers(profile.id),
      repo.listMessages(profile.id),
    ]);
    return c.json({ profile, papers, messages });
  });

  app.patch('/profiles/:id', async c => {
    const patch = await c.req.json().catch(() => ({}));
    const updated = await repo.updateProfile(c.get('ctx'), c.req.param('id'), patch);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  });

  app.delete('/profiles/:id', async c => {
    const id = c.req.param('id');
    const profile = await ownedOnly(c, id);
    if (!profile) return c.json({ error: 'Not found' }, 404);
    // Concurrent: the three stores are independent, and deletion latency is
    // otherwise the sum of a File Search call, a cascading delete and a blob sweep.
    await Promise.all([
      profile.fileSearchStoreName ? deleteStore(profile.fileSearchStoreName) : Promise.resolve(),
      repo.deleteProfile(c.get('ctx'), id),
      blobs.deleteByPrefix(profilePrefix(id)).catch(e => console.error('Blob cleanup failed:', e)),
    ]);
    return c.json({ ok: true });
  });

  // --- API keys ------------------------------------------------------------
  // A key authenticates a person who already exists. It acts as them and
  // inherits their grants exactly, so there is no second permission model to
  // keep in step with the ACLs — only a scope, which can narrow what the key
  // may do but never widen it.

  /**
   * Key management is deliberately closed to key-authenticated callers.
   *
   * Otherwise a write key could mint further keys — including ones that outlive
   * it — and revoking the original would no longer revoke the access it was
   * used to create. Minting requires a browser or IAP session.
   */
  const sessionOnly = (c: any) =>
    c.get('user').viaKey
      ? c.json(
          { error: 'API keys can only be managed from a signed-in session, not with a key.' },
          403
        )
      : null;

  app.get('/auth/me', async c => {
    const user = c.get('user');
    const ctx = c.get('ctx');
    return c.json({
      email: user.email,
      name: user.name,
      picture: user.picture,
      orgId: ctx.orgId,
      teamId: ctx.teamId,
      viaKey: !!user.viaKey,
      scope: user.scope ?? null,
    });
  });

  app.get('/keys', async c => c.json(await listKeys(c.get('ctx').userId)));

  app.post('/keys', async c => {
    const refused = sessionOnly(c);
    if (refused) return refused;

    const body = await c.req.json().catch(() => ({}));
    const { name, scope, expiresInDays } = body as {
      name?: string;
      scope?: KeyScope;
      expiresInDays?: number;
    };

    // Read is the default on purpose: a key pasted into a script or an MCP
    // client should not be able to delete a library unless that was asked for.
    const keyScope: KeyScope = scope === 'write' ? 'write' : 'read';
    const days = Number.isFinite(expiresInDays) ? Number(expiresInDays) : undefined;

    const ctx = c.get('ctx');
    const minted = await createKey(ctx.userId, ctx.orgId, name ?? 'Untitled key', keyScope, days);

    // The only time the key itself is ever returned. It is stored as a hash and
    // is not recoverable — losing it means minting another.
    return c.json({ key: minted.key, record: minted.record }, 201);
  });

  app.delete('/keys/:keyId', async c => {
    const refused = sessionOnly(c);
    if (refused) return refused;
    const ok = await revokeKey(c.get('ctx').userId, c.req.param('keyId'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  // --- Sharing -------------------------------------------------------------
  // Visibility is the broad control and lives on the profile itself; grants are
  // additive on top and name individual people. A grant can only widen access,
  // never narrow it, so a private library shared with one colleague is readable
  // by exactly its owner and that colleague.

  app.get('/profiles/:id/sharing', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json({
      visibility: profile.visibility,
      role: await profileRole(c.get('ctx'), profile.id),
      grants: await listGrants(profile.id),
      // Sharing is with people who already exist; there is no invitation flow,
      // and a grant to an address nobody has signed in as would match nothing.
      candidates: await listOrgUsers(c.get('ctx').orgId),
    });
  });

  const ROLES: Role[] = ['viewer', 'editor'];

  app.post('/profiles/:id/sharing', async c => {
    // Only the owner may change who else can reach a library. An editor can add
    // papers; letting them also add people would make sharing transitive by
    // accident.
    const profile = await ownedOnly(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const { email, principalType, principalId, role } = body as {
      email?: string;
      principalType?: PrincipalType;
      principalId?: string;
      role?: Role;
    };

    const grantRole: Role = ROLES.includes(role as Role) ? (role as Role) : 'viewer';

    if (email) {
      const user = await findUserByEmail(email);
      if (!user) {
        return c.json(
          { error: `No user here with the address ${email}. They need to sign in once first.` },
          404
        );
      }
      if (user.uuid === profile.ownerId) {
        return c.json({ error: 'That is already the owner of this library.' }, 409);
      }
      await grantAccess(c.get('ctx'), profile.id, 'user', user.uuid, grantRole);
      return c.json({ ok: true, grants: await listGrants(profile.id) }, 201);
    }

    if (!principalId || !principalType) {
      return c.json({ error: 'email, or principalType and principalId, are required' }, 400);
    }
    await grantAccess(c.get('ctx'), profile.id, principalType, principalId, grantRole);
    return c.json({ ok: true, grants: await listGrants(profile.id) }, 201);
  });

  app.delete('/profiles/:id/sharing', async c => {
    const profile = await ownedOnly(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const principalType = (c.req.query('principalType') || 'user') as PrincipalType;
    const principalId = c.req.query('principalId');
    if (!principalId) return c.json({ error: 'principalId is required' }, 400);
    await revokeAccess(profile.id, principalType, principalId);
    return c.json({ ok: true, grants: await listGrants(profile.id) });
  });

  // --- Papers -------------------------------------------------------------
  app.get('/profiles/:id/papers', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(await repo.listPapers(profile.id));
  });

  app.put('/profiles/:id/papers/:paperId', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const paper = (await c.req.json()) as Paper;
    await repo.upsertPaper(profile.id, { ...paper, id: c.req.param('paperId') });
    return c.json({ ok: true });
  });

  app.delete('/profiles/:id/papers/:paperId', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const paperId = c.req.param('paperId');
    // Drop the indexed document too, or chat keeps citing a deleted paper.
    const paper = (await repo.listPapers(profile.id)).find(p => p.id === paperId);
    if (paper?.fileSearchDocName) await deleteDocument(paper.fileSearchDocName);
    await removePaperFromIndex(profile.id, paperId);
    await repo.deletePaper(profile.id, paperId);
    await blobs.deleteByPrefix(`${profilePrefix(profile.id)}${paperId}/`);
    return c.json({ ok: true });
  });

  // --- Messages -----------------------------------------------------------
  app.get('/profiles/:id/messages', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(await repo.listMessages(profile.id));
  });

  app.post('/profiles/:id/messages', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const message = (await c.req.json()) as Message;
    await repo.appendMessage(profile.id, message);
    return c.json({ ok: true }, 201);
  });

  app.delete('/profiles/:id/messages', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    await repo.clearMessages(profile.id);
    return c.json({ ok: true });
  });

  // --- Blobs --------------------------------------------------------------
  // Keys are `profiles/{profileId}/{paperId}/{kind}`; ownership is checked on
  // the embedded profileId so a key alone is not a capability.
  app.get('/blobs/*', async c => {
    const key = c.req.path.replace('/api/blobs/', '');
    const profileId = key.split('/')[1];
    if (!key.startsWith('profiles/') || !profileId) return c.json({ error: 'Bad key' }, 400);
    if (!(await viewable(c, profileId))) return c.json({ error: 'Not found' }, 404);

    const blob = await blobs.get(key).catch(() => null);
    if (!blob) return c.json({ error: 'Not found' }, 404);

    // TTS bytes are stored exactly as the model emits them: headerless PCM.
    // Wrapping here means the browser receives a playable file and the client
    // needs no PCM decoding of its own.
    if (blob.contentType.includes('l16') || blob.contentType.includes('pcm')) {
      const rate = Number(blob.contentType.match(/rate=(\d+)/)?.[1]) || 24000;
      return c.body(new Uint8Array(pcmToWav(blob.data, rate)), 200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'private, max-age=3600',
      });
    }
    return c.body(new Uint8Array(blob.data), 200, {
      'Content-Type': blob.contentType,
      'Cache-Control': 'private, max-age=3600',
    });
  });

  // --- One-time import of the localStorage era ----------------------------
  app.post('/import/localstorage', async c => {
    const ctx = c.get('ctx');
    const legacy = (await c.req.json().catch(() => [])) as LegacyProfile[];
    if (!Array.isArray(legacy)) return c.json({ error: 'Expected an array of profiles' }, 400);

    const imported: string[] = [];
    for (const old of legacy) {
      const profile = await repo.createProfile(ctx, {
        id: old.id,
        title: old.title,
        emoji: old.emoji,
        theme: old.theme,
        createdAt: old.createdAt,
        scholarName: old.scholar?.name,
        affiliation: old.scholar?.affiliation,
        topics: old.scholar?.topics,
      });

      const papers: Paper[] = [];
      for (const paper of old.scholar?.papers ?? []) {
        const { illustration, audioBase64, ...rest } = paper;
        const next: Paper = { ...rest };

        if (illustration) {
          const data = Buffer.from(illustration, 'base64');
          const key = blobKey(profile.id, paper.id, 'illustration');
          const mime = sniffImageMime(data);
          await blobs.put(key, data, mime);
          next.illustrationKey = key;
          next.illustrationMime = mime;
        }
        if (audioBase64) {
          const data = Buffer.from(audioBase64, 'base64');
          const key = blobKey(profile.id, paper.id, 'audio');
          // Legacy audio is headerless PCM exactly as the TTS model emitted it.
          const mime = 'audio/l16; rate=24000; channels=1';
          await blobs.put(key, data, mime);
          next.audioKey = key;
          next.audioMime = mime;
        }
        papers.push(next);
      }

      await repo.upsertPapers(profile.id, papers);
      for (const message of old.chatMessages ?? []) {
        await repo.appendMessage(profile.id, message);
      }
      imported.push(profile.id);
    }

    return c.json({ ok: true, imported });
  });

  // --- Chat ----------------------------------------------------------------
  // File Search composes with neither Google Search nor URL Context, so the
  // caller picks one grounding mode per turn (verified: spike finding F2/O1).
  app.post('/chat', async c => {
    const body = await c.req.json().catch(() => ({}));
    const { profileId, message, useWebSearch } = body as {
      profileId?: string;
      message?: string;
      useWebSearch?: boolean;
    };
    if (!message?.trim()) return c.json({ error: 'message is required' }, 400);

    // Without a profileId this is the landing page asking across every library.
    const profile = profileId ? await viewable(c, profileId) : null;
    if (profileId && !profile) return c.json({ error: 'Not found' }, 404);

    // Papers only become searchable once they have been processed. Grounding an
    // empty store just produces "nothing covers this topic", so fall back to the
    // web and tell the client why.
    let storeNames: string[] = [];
    let indexed = 0;
    let total = 0;
    let searchedLibraries: string[] = [];
    let skippedLibraries = 0;

    if (profile) {
      const papers = await repo.listPapers(profile.id);
      indexed = papers.filter(p => p.fileSearchDocName).length;
      total = papers.length;
      if (profile.fileSearchStoreName && indexed) storeNames = [profile.fileSearchStoreName];
      searchedLibraries = indexed ? [profile.title] : [];
    } else {
      // A single call accepts at most five stores — six returns 400 (measured).
      // Most recently touched libraries win, and the client is told what was
      // left out rather than being quietly given a partial answer.
      const all = await repo.listProfiles(c.get('ctx'));
      const withContent = (
        await Promise.all(
          all.map(async p => {
            const papers = await repo.listPapers(p.id);
            const count = papers.filter(x => x.fileSearchDocName).length;
            return { profile: p, indexed: count, total: papers.length };
          })
        )
      ).filter(x => x.indexed > 0 && x.profile.fileSearchStoreName);

      withContent.sort((a, b) => b.profile.updatedAt - a.profile.updatedAt);
      const chosen = withContent.slice(0, MAX_ATTACHED_STORES);
      storeNames = chosen.map(x => x.profile.fileSearchStoreName!);
      searchedLibraries = chosen.map(x => x.profile.title);
      skippedLibraries = withContent.length - chosen.length;
      indexed = chosen.reduce((n, x) => n + x.indexed, 0);
      total = withContent.reduce((n, x) => n + x.total, 0);
    }

    const grounded = !useWebSearch && storeNames.length > 0;
    const tools = grounded ? [fileSearchTool(storeNames)] : [googleSearchTool()];

    const history = profile ? await repo.listMessages(profile.id) : [];
    const transcript = history
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    // An advisor profile answers in its own register. One library means the
    // five-store limit is irrelevant, so this keeps File Search and its
    // annotations rather than switching to the panel's retrieval path.
    const preamble =
      profile?.advisorEnabled
        ? systemPrompt(profile)
        : `You are an expert research assistant helping with a library of papers,
articles, recordings and videos.`;

    const input = `${preamble}
${grounded
  ? 'Answer using the indexed papers available through file search, and cite them.'
  : 'Answer using live web search.'}

${transcript ? `Conversation so far:\n${transcript}\n` : ''}
User: ${message}`;

    return streamSSE(c, async stream => {
      try {
        const result: any = await (ai().interactions as any).create({
          model: MODELS.text,
          input,
          tools,
          stream: true,
        });

        let full = '';
        // File Search reports its sources as annotations on the delta events.
        const citations = new Map<string, { fileName: string; documentUri: string; snippet: string }>();

        for await (const event of result) {
          const delta =
            event?.delta?.text ??
            event?.text ??
            (typeof event?.delta === 'string' ? event.delta : undefined);
          if (typeof delta === 'string' && delta) {
            full += delta;
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: delta }) });
          }

          for (const a of event?.delta?.annotations ?? event?.annotations ?? []) {
            const fileName = a?.file_name;
            if (!fileName || citations.has(fileName)) continue;
            citations.set(fileName, {
              fileName,
              documentUri: a?.document_uri ?? '',
              snippet: String(a?.source ?? '').replace(/\s+/g, ' ').trim().slice(0, 280),
            });
          }
        }
        if (!full) {
          // Fall back to a non-streamed turn if no deltas were recognised.
          const once = await ask({ input, tools });
          full = extractText(once);
          if (full) await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: full }) });
        }
        if (citations.size) {
          await stream.writeSSE({
            event: 'citations',
            data: JSON.stringify({ citations: [...citations.values()] }),
          });
        }
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            grounded,
            // Distinguishes "you asked for the web" from "your library is empty".
            fellBack: !grounded && !useWebSearch,
            indexed,
            pending: total - indexed,
            searchedLibraries,
            skippedLibraries,
          }),
        });
      } catch (error: any) {
        console.error('Chat error:', error);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: 'Could not retrieve a response. Please try again.' }),
        });
      }
    });
  });

  // --- Discovery ----------------------------------------------------------
  app.post('/profiles/:id/search', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json().catch(() => ({ query: '' }));
    const { query, allowDuplicate, mode } = body;
    if (!query?.trim()) return c.json({ error: 'query is required' }, 400);

    /**
     * Building a second library for a scholar the user already has means a
     * second store, a second set of embeddings and a divided chat history — so
     * it is surfaced rather than silently done. This is the cheap half of the
     * check, computable from the query alone and therefore answerable
     * immediately; the half that needs the resolved name runs in the job, still
     * before anything is written.
     */
    const fromQuery = scholarKey(query);
    if (!allowDuplicate && fromQuery) {
      const match = (await repo.findByScholarKeys(c.get('ctx'), [fromQuery])).find(
        p => p.id !== profile.id
      );
      if (match) {
        return c.json(
          {
            error: 'You already have a library for this scholar.',
            duplicate: {
              id: match.id,
              title: match.title,
              scholarName: match.scholarName,
              paperCount: (await repo.listPapers(match.id)).length,
            },
          },
          409
        );
      }
    }

    // Crawling a scholar with sixty papers takes minutes. The request records
    // the intent and returns; the worker does the work and the client polls.
    const ctx = c.get('ctx');
    const run = await jobs.createRun(ctx, profile.id, 'crawl', { query });
    const job = await jobs.enqueue(ctx, {
      type: 'crawl.profile',
      runId: run.id,
      payload: { profileId: profile.id, query, mode: mode ?? 'index', allowDuplicate: !!allowDuplicate },
      dedupeKey: `crawl:${profile.id}`,
      priority: 1,
    });
    if (!job) {
      await jobs.deleteRun(run.id);
      const active = await jobs.runForDedupeKeys([`crawl:${profile.id}`]);
      return c.json({ runId: active, profile, alreadyRunning: true }, 202);
    }
    return c.json({ runId: run.id, profile }, 202);
  });

  app.post('/profiles/:id/papers/find', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const { query } = await c.req.json().catch(() => ({ query: '' }));
    if (!query?.trim()) return c.json({ error: 'query is required' }, 400);

    const paper = await findSinglePaper(query);
    if (!paper) return c.json({ error: 'Could not find a paper with that title.' }, 404);

    const existing = await repo.listPapers(profile.id);
    if (existing.some(p => p.title.toLowerCase() === paper.title.toLowerCase())) {
      return c.json({ error: `"${paper.title}" is already in your list.` }, 409);
    }
    await repo.upsertPaper(profile.id, paper);
    return c.json(paper, 201);
  });

  // --- Sources (anything that is not a paper) ------------------------------
  // A link or an upload is read once, here, and stored as text. Everything
  // downstream — indexing, generation, chat, export — then treats it exactly
  // like a paper.
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

  app.post('/profiles/:id/sources', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const { url } = await c.req.json().catch(() => ({ url: '' }));
    if (!url?.trim()) return c.json({ error: 'url is required' }, 400);

    let parsed: URL;
    try {
      parsed = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
    } catch {
      return c.json({ error: 'That does not look like a link.' }, 400);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return c.json({ error: 'Only http and https links can be added.' }, 400);
    }

    const kind = detectKind(parsed.href);
    const existing = await repo.listPapers(profile.id);
    if (existing.some(p => p.sourceUrl === parsed.href)) {
      return c.json({ error: 'That link is already in this profile.' }, 409);
    }

    const extracted = await extractFromUrl(parsed.href, kind);
    const source: Paper = {
      id: `source-${Date.now()}`,
      kind,
      title: extracted.title,
      year: extracted.year,
      authors: extracted.authors,
      summary: extracted.summary,
      status: 'discovered',
      sourceUrl: parsed.href,
      extractedText: extracted.text,
    };
    await repo.upsertPaper(profile.id, source);
    return c.json(source, 201);
  });

  app.post('/profiles/:id/sources/upload', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!file || typeof file === 'string') return c.json({ error: 'file is required' }, 400);

    const mime = file.type || 'application/octet-stream';
    if (!isSupportedUpload(mime)) {
      return c.json({ error: `${mime} files are not supported.` }, 415);
    }

    const data = Buffer.from(await file.arrayBuffer());
    if (data.length > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'That file is larger than 50MB.' }, 413);
    }

    const kind = kindForMime(mime);
    const id = `source-${Date.now()}`;
    const extracted = await extractFromUpload(data, mime, file.name || 'upload');

    // Bytes stay in the blob store, as everything else does; the Files API copy
    // is released as soon as extraction finishes.
    const key = blobKey(profile.id, id, 'media');
    await blobs.put(key, data, mime);

    const source: Paper = {
      id,
      kind,
      title: extracted.title,
      year: extracted.year,
      authors: extracted.authors,
      summary: extracted.summary,
      status: 'discovered',
      extractedText: extracted.text,
      mediaKey: key,
      mediaMime: mime,
      fileName: file.name,
    };
    await repo.upsertPaper(profile.id, source);
    return c.json(source, 201);
  });

  app.post('/profiles/:id/papers/:paperId/citations', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const papers = await repo.listPapers(profile.id);
    const paper = papers.find(p => p.id === c.req.param('paperId'));
    if (!paper) return c.json({ error: 'Not found' }, 404);

    const citingPapers = await findCitingPapers(paper.title, paper.authors ?? []);
    await repo.upsertPaper(profile.id, { ...paper, citingPapers });
    return c.json(citingPapers);
  });

  // --- Pipeline (streams progress as each paper advances) ------------------
  // `mode` selects half the pipeline or both: 'index' makes papers searchable,
  // 'artifacts' writes the blog, slides, quiz, audio and illustration.
  app.post('/profiles/:id/process', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const { paperIds, mode } = await c.req.json().catch(() => ({ paperIds: [] }));

    const pipelineMode: PipelineMode =
      mode === 'index' || mode === 'artifacts' ? mode : 'both';

    const all = await repo.listPapers(profile.id);
    const selected = all.filter(p => (paperIds ?? []).includes(p.id));
    if (!selected.length) return c.json({ error: 'No papers selected' }, 400);

    const ctx = c.get('ctx');
    const run = await jobs.createRun(ctx, profile.id, pipelineMode, {
      papers: selected.length,
    });

    // One job per paper: a failure cannot abort the rest, each reports its own
    // progress, and asking twice for the same paper is a no-op while the first
    // request is still outstanding.
    const type = ({ index: 'paper.index', artifacts: 'paper.enrich', both: 'paper.process' } as const)[
      pipelineMode
    ];
    const dedupeKeys = selected.map(p => `${pipelineMode}:${profile.id}:${p.id}`);
    let enqueued = 0;
    for (const paper of selected) {
      const job = await jobs.enqueue(ctx, {
        type,
        runId: run.id,
        payload: { profileId: profile.id, paperId: paper.id },
        dedupeKey: `${pipelineMode}:${profile.id}:${paper.id}`,
      });
      if (job) enqueued += 1;
    }

    // Everything asked for is already in flight. Discard the run this request
    // opened — it holds nothing, and left in place it would become the
    // profile's latest run and mask the one actually working.
    if (!enqueued) {
      await jobs.deleteRun(run.id);
      const active = await jobs.runForDedupeKeys(dedupeKeys);
      return c.json({ runId: active, enqueued: 0, skipped: selected.length, alreadyRunning: true }, 202);
    }

    return c.json({ runId: run.id, enqueued, skipped: selected.length - enqueued }, 202);
  });

  // --- Runs and status -----------------------------------------------------
  // Polled, not streamed: the work outlives the request that started it, so a
  // connection is the wrong thing to hang progress off. The job rows *are* the
  // status, and `job_events` carries finer detail than the SSE frames it
  // replaces.

  /** Same body, same ETag — a repeat poll costs one 304 and no serialisation. */
  const etagged = (c: any, body: unknown) => {
    const json = JSON.stringify(body);
    let hash = 5381;
    for (let i = 0; i < json.length; i += 1) hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
    const etag = `W/"${(hash >>> 0).toString(36)}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag });
    return c.body(json, 200, { ETag: etag, 'Content-Type': 'application/json' });
  };

  app.get('/runs/:runId', async c => {
    const run = await jobs.getRun(c.req.param('runId'));
    if (!run) return c.json({ error: 'Not found' }, 404);
    // A run is reachable exactly when its profile is.
    if (!(await viewable(c, run.profileId))) return c.json({ error: 'Not found' }, 404);
    return etagged(c, { run, progress: await jobs.runProgress(run.id) });
  });

  /**
   * The three lifecycles a user actually asks about, derived from the fields the
   * pipeline already writes rather than duplicated into columns of their own —
   * a second copy is a second thing to keep in sync, and the pipeline has
   * already been bitten by exactly that.
   */
  const paperStatus = (paper: Paper) => {
    const downloading = paper.stage === 'resolving' || paper.stage === 'fetching';
    const download = downloading
      ? 'running'
      : paper.pdfStatus === 'fetched'
        ? 'done'
        : paper.pdfStatus === 'unavailable'
          ? 'unavailable'
          : paper.pdfStatus === 'error'
            ? 'error'
            : 'pending';

    const enrich =
      paper.status === 'converted'
        ? 'done'
        : paper.status === 'error'
          ? 'error'
          : paper.status === 'processing' || paper.status === 'downloading'
            ? 'running'
            : 'pending';

    const index =
      paper.indexStatus === 'indexed'
        ? 'done'
        : paper.indexStatus === 'error'
          ? 'error'
          : paper.indexStatus === 'indexing'
            ? 'running'
            : 'pending';

    return { id: paper.id, title: paper.title, stage: paper.stage ?? null, download, enrich, index };
  };

  app.get('/profiles/:id/status', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const [papers, run] = await Promise.all([
      repo.listPapers(profile.id),
      jobs.latestRun(profile.id),
    ]);
    return etagged(c, {
      run,
      progress: run ? await jobs.runProgress(run.id) : null,
      papers: papers.map(paperStatus),
    });
  });

  // --- Search --------------------------------------------------------------
  // The query File Search cannot answer: one search across every library the
  // caller can reach, however many that is. Retrieval and the ACL check are the
  // same query, so there is no post-filter to forget.

  const SCOPES: Scope[] = ['me', 'team', 'org', 'profile'];

  app.get('/search', async c => {
    const q = c.req.query('q') ?? '';
    if (!q.trim()) return c.json({ error: 'q is required' }, 400);

    const requested = c.req.query('scope') as Scope | undefined;
    const profileId = c.req.query('profileId');
    const scope: Scope = profileId ? 'profile' : SCOPES.includes(requested as Scope) ? (requested as Scope) : 'org';

    const hits = await search(c.get('ctx'), q, {
      scope,
      profileId,
      limit: Number(c.req.query('limit')) || 20,
    });
    return c.json({ query: q, scope, hits });
  });

  // --- Advisors ------------------------------------------------------------
  // An advisor is a profile with a persona. It keeps its library, its crawler,
  // its index and its sharing — consulting one is reading someone's published
  // work through a voice, not talking to a simulation of them.

  app.get('/advisors', async c => c.json(await repo.listAdvisors(c.get('ctx'))));

  app.patch('/profiles/:id/advisor', async c => {
    const profile = await editable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const { enabled, name, title, brief } = body as {
      enabled?: boolean;
      name?: string;
      title?: string;
      brief?: string;
    };

    const updated = await repo.updateProfile(c.get('ctx'), profile.id, {
      advisorEnabled: enabled ?? profile.advisorEnabled,
      advisorName: name ?? profile.advisorName,
      advisorTitle: title ?? profile.advisorTitle,
      advisorBrief: brief ?? profile.advisorBrief,
    });
    return updated ? c.json(updated) : c.json({ error: 'Not found' }, 404);
  });

  /**
   * Ask several advisors one question.
   *
   * Streamed per advisor rather than returned whole: each is a retrieval plus a
   * model call, so the first answer arrives in seconds instead of after the
   * slowest. Retrieval comes from Postgres and no grounding tool is attached —
   * File Search caps a call at five stores, which is exactly the query a panel
   * is.
   */
  app.post('/consult', async c => {
    const ctx = c.get('ctx');
    const body = await c.req.json().catch(() => ({}));
    const { question, advisorIds, synthesise: wantSynthesis } = body as {
      question?: string;
      advisorIds?: string[];
      synthesise?: boolean;
    };

    if (!question?.trim()) return c.json({ error: 'question is required' }, 400);
    if (!advisorIds?.length) return c.json({ error: 'Pick at least one advisor.' }, 400);

    // Unreachable ids are dropped and *reported*. Silently ignoring one would
    // mean an answer that looks like the panel asked for and is not.
    const resolved = await Promise.all(advisorIds.slice(0, maxPanel()).map(id => viewable(c, id)));
    const advisors = resolved.filter((p): p is repo.ProfileRecord => !!p && p.advisorEnabled);
    const unavailable = advisorIds.length - advisors.length;

    if (!advisors.length) {
      return c.json({ error: 'None of those advisors are available to you.' }, 404);
    }

    return streamSSE(c, async stream => {
      try {
        const answers: AdvisorAnswer[] = [];

        await pooled(
          advisors.map(profile => async () => {
            const answer = await askAdvisor(ctx, profile, question);
            answers.push(answer);
            await stream
              .writeSSE({ event: 'advisor', data: JSON.stringify(answer) })
              .catch(() => {
                // The client may have navigated away; the remaining advisors
                // still run and the consultation is still recorded.
              });
            return answer;
          }),
          panelConcurrency()
        );

        const synthesis = wantSynthesis ? await synthesise(question, answers) : undefined;
        if (synthesis) {
          await stream.writeSSE({ event: 'synthesis', data: JSON.stringify({ synthesis }) });
        }

        // Recorded after the fact, so a client that disconnected mid-panel can
        // still find the answers it missed.
        const id = await repo.saveConsultation(ctx, question, answers, synthesis);

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ consultationId: id, consulted: advisors.length, unavailable }),
        });
      } catch (error: any) {
        console.error('Consultation failed:', error);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: error?.message ?? 'Consultation failed' }),
        });
      }
    });
  });

  app.get('/consultations', async c => c.json(await repo.listConsultations(c.get('ctx'))));

  app.get('/consultations/:consultationId', async c => {
    const found = await repo.getConsultation(c.get('ctx'), c.req.param('consultationId'));
    return found ? c.json(found) : c.json({ error: 'Not found' }, 404);
  });

  // --- Crawlers ------------------------------------------------------------
  // A crawler is the standing definition; a run is one execution of it.

  app.get('/crawlers', async c =>
    c.json(await listCrawlers(c.get('ctx'), c.req.query('profileId')))
  );

  app.post('/crawlers', async c => {
    const body = await c.req.json().catch(() => ({}));
    const { profileId, target, intervalSeconds, kind } = body;
    if (!profileId || !target?.trim()) {
      return c.json({ error: 'profileId and target are required' }, 400);
    }
    const profile = await editable(c, profileId);
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(
      await upsertCrawler(c.get('ctx'), profileId, target, { kind, intervalSeconds }),
      201
    );
  });

  app.patch('/crawlers/:crawlerId', async c => {
    const patch = await c.req.json().catch(() => ({}));
    const updated = await updateCrawler(c.get('ctx'), c.req.param('crawlerId'), patch);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  });

  app.delete('/crawlers/:crawlerId', async c => {
    const ok = await deleteCrawler(c.get('ctx'), c.req.param('crawlerId'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
  });

  app.post('/crawlers/:crawlerId/run', async c => {
    const ctx = c.get('ctx');
    const crawler = await getCrawler(ctx, c.req.param('crawlerId'));
    if (!crawler) return c.json({ error: 'Not found' }, 404);
    const run = await jobs.createRun(ctx, crawler.profileId, 'crawl',
      { target: crawler.target, manual: true }, crawler.id);
    await jobs.enqueue(ctx, {
      type: 'crawl.profile',
      runId: run.id,
      payload: { profileId: crawler.profileId, query: crawler.target, mode: 'index', allowDuplicate: true },
      dedupeKey: `crawl:${crawler.profileId}`,
      priority: 1,
    });
    return c.json({ runId: run.id }, 202);
  });

  // --- Citations -----------------------------------------------------------
  // Formatted from stored metadata, enriched once from Crossref. Never from the
  // model: an invented volume number reads as authoritative and gets pasted
  // into somebody's bibliography.
  const parseStyle = (raw: string | undefined): CitationStyle | null => {
    const style = (raw || 'bibtex').toLowerCase() as CitationStyle;
    return STYLES.includes(style) ? style : null;
  };

  /** Fills in DOI, journal, volume and pages the first time they are asked for. */
  const enrich = async (profileId: string, papers: Paper[]): Promise<Paper[]> =>
    Promise.all(
      papers.map(async paper => {
        if (paper.citationMeta || (paper.kind ?? 'paper') !== 'paper') return paper;
        const citationMeta = await lookupCitationMeta(paper.title);
        if (!citationMeta) return paper;
        const updated = { ...paper, citationMeta };
        await repo.upsertPaper(profileId, updated).catch(() => {});
        return updated;
      })
    );

  app.get('/profiles/:id/citations', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);

    const style = parseStyle(c.req.query('style'));
    if (!style) {
      return c.json({ error: `style must be one of: ${STYLES.join(', ')}` }, 400);
    }

    const papers = await enrich(profile.id, await repo.listPapers(profile.id));
    const now = new Date();
    const text = formatBibliography(papers, style, now);

    if (c.req.query('download')) {
      const extension = style === 'bibtex' ? 'bib' : style === 'ris' ? 'ris' : 'txt';
      return c.body(text, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${profile.title.replace(/[^\w.-]+/g, '-')}.${extension}"`,
      });
    }

    return c.json({
      style,
      count: papers.length,
      text,
      entries: papers.map(p => ({ id: p.id, title: p.title, citation: formatCitation(p, style, now) })),
    });
  });

  app.get('/profiles/:id/papers/:paperId/citation', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);

    const style = parseStyle(c.req.query('style'));
    if (!style) return c.json({ error: `style must be one of: ${STYLES.join(', ')}` }, 400);

    const papers = await repo.listPapers(profile.id);
    const paper = papers.find(p => p.id === c.req.param('paperId'));
    if (!paper) return c.json({ error: 'Not found' }, 404);

    const [enriched] = await enrich(profile.id, [paper]);
    // Every style for one source: the picker switches without a round trip.
    const now = new Date();
    return c.json({
      id: enriched.id,
      title: enriched.title,
      hasBibliographicData: !!enriched.citationMeta,
      citations: Object.fromEntries(STYLES.map(s => [s, formatCitation(enriched, s, now)])),
    });
  });

  // --- Speech (used by the conversational quiz host) ----------------------
  app.post('/tts', async c => {
    const { text, voice } = await c.req.json().catch(() => ({}));
    if (!text?.trim()) return c.json({ error: 'text is required' }, 400);
    const audio = await generateAudio(text, voice || 'Kore');
    if (!audio) return c.json({ error: 'Speech generation failed' }, 502);
    const rate = Number(audio.mime.match(/rate=(\d+)/)?.[1]) || 24000;
    return c.body(new Uint8Array(pcmToWav(audio.data, rate)), 200, { 'Content-Type': 'audio/wav' });
  });

  // --- Export --------------------------------------------------------------
  app.get('/profiles/:id/export', async c => {
    const profile = await viewable(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const papers = await repo.listPapers(profile.id);
    const zip = await buildProfileZip(profile, papers, blobs);
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${profile.title.replace(/[^\w.-]+/g, '-')}.zip"`,
    });
  });

  return app;
};
