/**
 * Phase 0 spike — verifies the assumptions the GCP-native plan depends on.
 * Run:  GEMINI_API_KEY=... node scripts/spike-phase0.mjs
 * Add --with-store to also exercise File Search (creates + deletes a real store; costs embedding tokens).
 */
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('Set GEMINI_API_KEY'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey });
const WITH_STORE = process.argv.includes('--with-store');
const results = [];

const run = async (name, fn) => {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const detail = await fn();
    results.push([name, 'PASS', detail ?? '']);
    console.log(`  ✅ ${detail ?? 'ok'}`);
  } catch (e) {
    const msg = (e?.message ?? String(e)).replace(/\s+/g, ' ').slice(0, 220);
    results.push([name, 'FAIL', msg]);
    console.log(`  ❌ ${msg}`);
  }
};

// Q1 — do the model IDs in the plan actually resolve?
const WANT = {
  text:  'gemini-3.8-flash',
  image: 'gemini-3.1-flash-image',
  tts:   'gemini-3.1-flash-tts-preview',
  embed: 'gemini-embedding-2',
};
await run('Q1a list available models', async () => {
  const seen = [];
  for await (const m of await ai.models.list()) seen.push(m.name?.replace(/^models\//, ''));
  const hit = Object.entries(WANT).map(([k, v]) => `${k}:${v}=${seen.includes(v) ? 'YES' : 'no'}`);
  console.log(`  ${seen.length} models visible`);
  console.log(`  matching "gemini-3": ${seen.filter(n => n?.startsWith('gemini-3')).join(', ') || '(none)'}`);
  return hit.join('  ');
});

await run('Q1b text model generates', async () => {
  const r = await ai.models.generateContent({ model: WANT.text, contents: 'Reply with the single word: ok' });
  return `${WANT.text} → ${(r.text ?? '').trim().slice(0, 40)}`;
});

// Q2 — is interactions.create usable, and does response_format enforce a schema?
await run('Q2a interactions.create basic', async () => {
  const r = await ai.interactions.create({ model: WANT.text, input: 'Reply with the single word: ok' });
  return `keys: ${Object.keys(r ?? {}).slice(0, 8).join(', ')}`;
});

await run('Q2b interactions structured output via response_format', async () => {
  const r = await ai.interactions.create({
    model: WANT.text,
    input: 'Give one paper title and its year.',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'paper',
        schema: {
          type: 'object',
          properties: { title: { type: 'string' }, year: { type: 'string' } },
          required: ['title', 'year'],
        },
      },
    },
  });
  return JSON.stringify(r).slice(0, 180);
});

// Q3 — F2: can file_search combine with google_search / url_context?
await run('Q3a google_search alone', async () => {
  const r = await ai.interactions.create({
    model: WANT.text, input: 'Who wrote "Attention Is All You Need"?',
    tools: [{ type: 'google_search' }],
  });
  return 'accepted';
});

await run('Q3b url_context reads an arXiv PDF', async () => {
  const r = await ai.interactions.create({
    model: WANT.text,
    input: 'Summarise https://arxiv.org/pdf/1706.03762 in one sentence.',
    tools: [{ type: 'url_context' }],
  });
  return 'accepted — ' + JSON.stringify(r).slice(0, 120);
});

await run('Q3c file_search + google_search TOGETHER (expect rejection)', async () => {
  await ai.interactions.create({
    model: WANT.text, input: 'test',
    tools: [
      { type: 'file_search', file_search_store_names: ['fileSearchStores/does-not-exist'] },
      { type: 'google_search' },
    ],
  });
  return 'ACCEPTED — F2 constraint does NOT hold, chat can use both';
});

await run('Q3d file_search + url_context TOGETHER (expect rejection)', async () => {
  await ai.interactions.create({
    model: WANT.text, input: 'test',
    tools: [
      { type: 'file_search', file_search_store_names: ['fileSearchStores/does-not-exist'] },
      { type: 'url_context' },
    ],
  });
  return 'ACCEPTED — F2 constraint does NOT hold';
});

// Q4 — are TTS and image reachable via interactions, or must they stay on generateContent?
await run('Q4a TTS via generateContent', async () => {
  const r = await ai.models.generateContent({
    model: WANT.tts, contents: [{ parts: [{ text: 'Hello.' }] }],
    config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
  });
  const d = r.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  return `mime=${d?.mimeType} bytes≈${d?.data ? Math.round(d.data.length * 0.75) : 0}`;
});

await run('Q4b TTS via interactions', async () => {
  const r = await ai.interactions.create({
    model: WANT.tts, input: 'Hello.',
    response_format: { type: 'audio' },
  });
  return 'accepted — ' + JSON.stringify(r).slice(0, 120);
});

await run('Q4c image via generateContent', async () => {
  const r = await ai.models.generateContent({
    model: WANT.image, contents: { parts: [{ text: 'A minimal blue circle.' }] },
  });
  const part = (r.candidates?.[0]?.content?.parts ?? []).find(p => p.inlineData);
  return `mime=${part?.inlineData?.mimeType}`;
});

await run('Q4d image via interactions', async () => {
  const r = await ai.interactions.create({
    model: WANT.image, input: 'A minimal blue circle.',
    response_format: { type: 'image' },
  });
  return 'accepted — ' + JSON.stringify(r).slice(0, 120);
});

// Q5 — File Search round trip (opt-in: creates real cloud resources)
if (WITH_STORE) {
  let store;
  await run('Q5a create File Search store', async () => {
    store = await ai.fileSearchStores.create({
      config: { displayName: 'spike-phase0-temp', embeddingModel: `models/${WANT.embed}` },
    });
    return store.name;
  });
  if (store) {
    await run('Q5b upload a Blob to the store', async () => {
      const blob = new Blob([`ScholarMind spike marker: the capital of Atlantis is Nubira.`], { type: 'text/plain' });
      const op = await ai.fileSearchStores.uploadToFileSearchStore({
        file: blob, fileSearchStoreName: store.name,
        config: { displayName: 'spike-doc', customMetadata: [{ key: 'paperId', stringValue: 'spike-1' }] },
      });
      return `operation=${op?.name ?? 'started'}`;
    });
    await run('Q5c query the store', async () => {
      const r = await ai.interactions.create({
        model: WANT.text, input: 'What is the capital of Atlantis?',
        tools: [{ type: 'file_search', file_search_store_names: [store.name] }],
      });
      return JSON.stringify(r).slice(0, 200);
    });
    await run('Q5d delete the store', async () => {
      await ai.fileSearchStores.delete({ name: store.name, config: { force: true } });
      return 'deleted';
    });
  }
} else {
  console.log('\n⏭  Q5 File Search round trip skipped (pass --with-store to run)');
}

console.log('\n\n================ SUMMARY ================');
for (const [n, s, d] of results) console.log(`${s === 'PASS' ? '✅' : '❌'} ${n}\n     ${d}`);
