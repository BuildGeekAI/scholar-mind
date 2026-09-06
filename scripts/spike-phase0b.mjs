/**
 * Phase 0 follow-up — resolves the three questions the first spike left open.
 * Run:  GEMINI_API_KEY=... node scripts/spike-phase0b.mjs
 */
import { GoogleGenAI } from '@google/genai';
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('Set GEMINI_API_KEY'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey });
const TEXT = 'gemini-3.8-flash', EMBED = 'gemini-embedding-2';
const results = [];
const run = async (name, fn) => {
  process.stdout.write(`\n▶ ${name}\n`);
  try { const d = await fn(); results.push([name,'PASS',d??'']); console.log(`  ✅ ${d ?? 'ok'}`); }
  catch (e) { const m=(e?.message??String(e)).replace(/\s+/g,' ').slice(0,240); results.push([name,'FAIL',m]); console.log(`  ❌ ${m}`); }
};

// A — response_format takes a JSON-Schema-shaped object directly (not an OpenAI json_schema wrapper).
await run('A1 response_format as inline object schema', async () => {
  const r = await ai.interactions.create({
    model: TEXT, input: 'Give one famous ML paper title and its year.',
    response_format: {
      type: 'object',
      properties: { title: { type: 'string' }, year: { type: 'string' } },
      required: ['title','year'],
    },
  });
  return JSON.stringify(r).slice(0, 300);
});

// B — how do you actually get the output text out of an Interaction? Dump the step shape.
await run('B1 anatomy of interaction.steps', async () => {
  const r = await ai.interactions.create({ model: TEXT, input: 'Reply with exactly: hello' });
  console.log('  steps:', JSON.stringify(r.steps, null, 2).slice(0, 900));
  console.log('  convenience accessors →',
    ['text','output_text','outputText'].map(k => `${k}=${JSON.stringify(r?.[k])?.slice(0,60)}`).join(' | '));
  return `${r.steps?.length ?? 0} step(s); types: ${(r.steps??[]).map(s=>s.type).join(', ')}`;
});

// C — the decisive one: does file_search + url_context combine, using a REAL store?
let store;
await run('C1 create temp store', async () => {
  store = await ai.fileSearchStores.create({
    config: { displayName: 'spike-0b-temp', embeddingModel: `models/${EMBED}` } });
  return store.name;
});
if (store) {
  await run('C2 upload a doc', async () => {
    const blob = new Blob(['ScholarMind marker: the Nubira coefficient equals 42.'], { type: 'text/plain' });
    const op = await ai.fileSearchStores.uploadToFileSearchStore({
      file: blob, fileSearchStoreName: store.name, config: { displayName: 'spike-doc' } });
    return `op=${op?.name ?? 'started'}`;
  });
  await run('C3 file_search ALONE (real store)', async () => {
    const r = await ai.interactions.create({ model: TEXT,
      input: 'What is the Nubira coefficient?',
      tools: [{ type:'file_search', file_search_store_names:[store.name] }] });
    return JSON.stringify(r).slice(0, 220);
  });
  await run('C4 file_search + url_context TOGETHER (real store) — THE QUESTION', async () => {
    const r = await ai.interactions.create({ model: TEXT,
      input: 'What is the Nubira coefficient? Also summarise https://arxiv.org/pdf/1706.03762 in one line.',
      tools: [{ type:'file_search', file_search_store_names:[store.name] }, { type:'url_context' }] });
    return 'ACCEPTED — the two DO combine. ' + JSON.stringify(r).slice(0, 180);
  });
  await run('C5 file_search + google_search (real store, re-confirm)', async () => {
    const r = await ai.interactions.create({ model: TEXT, input: 'test',
      tools: [{ type:'file_search', file_search_store_names:[store.name] }, { type:'google_search' }] });
    return 'ACCEPTED (unexpected)';
  });
  await run('C6 delete temp store', async () => {
    await ai.fileSearchStores.delete({ name: store.name, config: { force: true } });
    return 'deleted';
  });
}

// D — confirm the illustration mime type, since the app hard-codes data:image/png
await run('D1 image mime from generateContent', async () => {
  const r = await ai.models.generateContent({ model:'gemini-3.1-flash-image',
    contents:{ parts:[{ text:'A minimal blue circle on white.' }] } });
  const p = (r.candidates?.[0]?.content?.parts ?? []).find(x => x.inlineData);
  return `mimeType=${p?.inlineData?.mimeType}  (app currently hard-codes data:image/png)`;
});

console.log('\n\n================ SUMMARY ================');
for (const [n,s,d] of results) console.log(`${s==='PASS'?'✅':'❌'} ${n}\n     ${d}`);
