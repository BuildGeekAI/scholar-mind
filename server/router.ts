import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LegacyProfile, Message, Paper } from '../types';
import { resolveUser, User } from './identity';
import { blobKey, createBlobStore, profilePrefix } from './blobStore';
import * as repo from './repository';
import { createStore, deleteStore } from './fileSearch';
import { processPapers } from './ingest';
import { buildProfileZip, pcmToWav } from './export';
import {
  ask,
  extractText,
  fileSearchTool,
  findCitingPapers,
  generateAudio,
  findSinglePaper,
  googleSearchTool,
  searchScholarAndPapers,
  MODELS,
  ai,
} from './gemini';

type Env = { Variables: { user: User } };

const blobs = createBlobStore();

/** Legacy inline artifacts carry no mime type, so recover it from the magic bytes. */
const sniffImageMime = (data: Buffer): string => {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  return 'application/octet-stream';
};

export const createRouter = () => {
  const app = new Hono<Env>().basePath('/api');

  app.get('/healthz', c =>
    c.json({
      ok: true,
      geminiKey: process.env.GEMINI_API_KEY ? 'configured' : 'MISSING',
      firestore: process.env.FIRESTORE_EMULATOR_HOST ? 'emulator' : 'cloud',
      blobs: process.env.GCS_BUCKET ? 'gcs' : 'filesystem',
    })
  );

  app.use('*', async (c, next) => {
    if (c.req.path === '/api/healthz') return next();
    const user = await resolveUser(c.req.raw.headers);
    if (!user) return c.json({ error: 'Unauthenticated' }, 401);
    c.set('user', user);
    await next();
  });

  /** Loads a profile only if the caller owns it. */
  const owned = async (c: any, id: string) => repo.getProfile(c.get('user').id, id);

  // --- Profiles -----------------------------------------------------------
  app.get('/profiles', async c => c.json(await repo.listProfiles(c.get('user').id)));

  app.post('/profiles', async c => {
    const body = await c.req.json().catch(() => ({}));
    const created = await repo.createProfile(c.get('user').id, {
      id: body.id || crypto.randomUUID(),
      title: body.title,
      emoji: body.emoji,
      theme: body.theme,
    });
    // Per-profile retrieval store; absence is tolerated and simply disables RAG.
    const fileSearchStoreName = await createStore(created.title);
    if (fileSearchStoreName) {
      await repo.updateProfile(c.get('user').id, created.id, { fileSearchStoreName });
      created.fileSearchStoreName = fileSearchStoreName;
    }
    return c.json(created, 201);
  });

  app.get('/profiles/:id', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const [papers, messages] = await Promise.all([
      repo.listPapers(profile.id),
      repo.listMessages(profile.id),
    ]);
    return c.json({ profile, papers, messages });
  });

  app.patch('/profiles/:id', async c => {
    const patch = await c.req.json().catch(() => ({}));
    const updated = await repo.updateProfile(c.get('user').id, c.req.param('id'), patch);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  });

  app.delete('/profiles/:id', async c => {
    const id = c.req.param('id');
    const profile = await owned(c, id);
    if (!profile) return c.json({ error: 'Not found' }, 404);
    if (profile.fileSearchStoreName) await deleteStore(profile.fileSearchStoreName);
    await repo.deleteProfile(c.get('user').id, id);
    await blobs.deleteByPrefix(profilePrefix(id));
    return c.json({ ok: true });
  });

  // --- Papers -------------------------------------------------------------
  app.get('/profiles/:id/papers', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(await repo.listPapers(profile.id));
  });

  app.put('/profiles/:id/papers/:paperId', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const paper = (await c.req.json()) as Paper;
    await repo.upsertPaper(profile.id, { ...paper, id: c.req.param('paperId') });
    return c.json({ ok: true });
  });

  app.delete('/profiles/:id/papers/:paperId', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const paperId = c.req.param('paperId');
    await repo.deletePaper(profile.id, paperId);
    await blobs.deleteByPrefix(`${profilePrefix(profile.id)}${paperId}/`);
    return c.json({ ok: true });
  });

  // --- Messages -----------------------------------------------------------
  app.get('/profiles/:id/messages', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    return c.json(await repo.listMessages(profile.id));
  });

  app.post('/profiles/:id/messages', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const message = (await c.req.json()) as Message;
    await repo.appendMessage(profile.id, message);
    return c.json({ ok: true }, 201);
  });

  app.delete('/profiles/:id/messages', async c => {
    const profile = await owned(c, c.req.param('id'));
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
    if (!(await owned(c, profileId))) return c.json({ error: 'Not found' }, 404);

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
    const ownerId = c.get('user').id;
    const legacy = (await c.req.json().catch(() => [])) as LegacyProfile[];
    if (!Array.isArray(legacy)) return c.json({ error: 'Expected an array of profiles' }, 400);

    const imported: string[] = [];
    for (const old of legacy) {
      const profile = await repo.createProfile(ownerId, {
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
    if (!profileId || !message?.trim()) return c.json({ error: 'profileId and message are required' }, 400);

    const profile = await owned(c, profileId);
    if (!profile) return c.json({ error: 'Not found' }, 404);

    const grounded = !useWebSearch && !!profile.fileSearchStoreName;
    const tools = grounded
      ? [fileSearchTool([profile.fileSearchStoreName!])]
      : [googleSearchTool()];

    const history = await repo.listMessages(profileId);
    const transcript = history
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const input = `You are an expert research assistant helping with a library of papers.
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
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ grounded }) });
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
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const { query } = await c.req.json().catch(() => ({ query: '' }));
    if (!query?.trim()) return c.json({ error: 'query is required' }, 400);

    try {
      const result = await searchScholarAndPapers(query);
      await repo.upsertPapers(profile.id, result.papers);
      const updated = await repo.updateProfile(c.get('user').id, profile.id, {
        scholarName: query,
        affiliation: result.affiliation,
        topics: result.topics,
      });
      return c.json({ profile: updated, papers: result.papers });
    } catch (error: any) {
      // Scholar search re-throws by design so the UI can surface the failure.
      console.error('Scholar search failed:', error);
      const raw = error?.message ?? '';

      if (raw.includes('GEMINI_API_KEY is not set')) {
        return c.json(
          { error: 'The server has no Gemini API key. Add GEMINI_API_KEY to .env and restart.' },
          503
        );
      }
      if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|401|403/.test(raw)) {
        return c.json({ error: 'The Gemini API key was rejected. Check GEMINI_API_KEY in .env.' }, 502);
      }
      if (/429|quota|RESOURCE_EXHAUSTED/.test(raw)) {
        return c.json({ error: 'API quota exceeded. Please try again in a few minutes.' }, 502);
      }
      return c.json({ error: `Failed to find scholar info: ${raw || 'unknown error'}` }, 502);
    }
  });

  app.post('/profiles/:id/papers/find', async c => {
    const profile = await owned(c, c.req.param('id'));
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

  app.post('/profiles/:id/papers/:paperId/citations', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const papers = await repo.listPapers(profile.id);
    const paper = papers.find(p => p.id === c.req.param('paperId'));
    if (!paper) return c.json({ error: 'Not found' }, 404);

    const citingPapers = await findCitingPapers(paper.title, paper.authors ?? []);
    await repo.upsertPaper(profile.id, { ...paper, citingPapers });
    return c.json(citingPapers);
  });

  // --- Generation pipeline (streams progress as each paper advances) --------
  app.post('/profiles/:id/process', async c => {
    const profile = await owned(c, c.req.param('id'));
    if (!profile) return c.json({ error: 'Not found' }, 404);
    const { paperIds } = await c.req.json().catch(() => ({ paperIds: [] }));

    const all = await repo.listPapers(profile.id);
    const selected = all.filter(p => (paperIds ?? []).includes(p.id));
    if (!selected.length) return c.json({ error: 'No papers selected' }, 400);

    return streamSSE(c, async stream => {
      try {
        await processPapers(profile.id, selected, blobs, profile.fileSearchStoreName, async paper => {
          await stream.writeSSE({ event: 'paper', data: JSON.stringify(paper) });
        });
        await stream.writeSSE({ event: 'done', data: '{}' });
      } catch (error: any) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: error?.message ?? 'Processing failed' }),
        });
      }
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
    const profile = await owned(c, c.req.param('id'));
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
