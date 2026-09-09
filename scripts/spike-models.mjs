/**
 * Which models exist, and which of them can actually ground.
 *
 * Run:  GEMINI_API_KEY=... node scripts/spike-models.mjs
 *
 * The question this answers is not "does model X work" but "does model X
 * *refuse* a tool it cannot use, or silently ignore it". The second is the
 * dangerous case: a scholar search that quietly stops grounding does not fail,
 * it returns a fluent, invented publication list — and nothing downstream can
 * tell the difference.
 */
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('Set GEMINI_API_KEY'); process.exit(1); }

const ai = new GoogleGenAI({ apiKey });

console.log('\n▶ Models visible to this key\n');
const names = [];
for await (const m of await ai.models.list()) {
  const name = m.name?.replace(/^models\//, '');
  if (name) names.push(name);
}
const groups = {
  gemini: names.filter(n => n.startsWith('gemini')),
  gemma: names.filter(n => n.startsWith('gemma')),
  other: names.filter(n => !n.startsWith('gemini') && !n.startsWith('gemma')),
};
for (const [label, list] of Object.entries(groups)) {
  if (list.length) console.log(`  ${label.padEnd(7)} ${list.join(', ')}`);
}

// Candidates for PLAIN_TEXT_MODEL: anything the caller names, else every Gemma.
const candidates = process.argv.slice(2).filter(a => !a.startsWith('-'));
const totest = candidates.length ? candidates : groups.gemma.slice(0, 6);

if (!totest.length) {
  console.log('\n  No Gemma models visible. Pass model ids as arguments to test specific ones.\n');
  process.exit(0);
}

const check = async (model) => {
  const result = { model, plain: '—', tooled: '—' };

  // 1. Plain text, no tools. This is what PLAIN_TEXT_MODEL has to do.
  try {
    const r = await ai.interactions.create({ model, input: 'Reply with the single word: ok' });
    const steps = r?.steps ?? [];
    const text = steps
      .flatMap(s => s.content ?? [])
      .map(c => c?.text ?? '')
      .join('')
      .trim();
    result.plain = text ? `ok (${text.slice(0, 20)})` : 'empty response';
  } catch (e) {
    result.plain = `FAIL ${(e?.message ?? e).toString().slice(0, 60)}`;
  }

  // 2. With google_search attached. A clean refusal is GOOD — it means a
  //    misconfiguration surfaces immediately instead of silently ungrounding.
  try {
    await ai.interactions.create({
      model,
      input: 'Who won the 2024 Nobel Prize in Physics? Search for it.',
      tools: [{ type: 'google_search' }],
    });
    result.tooled = 'ACCEPTED — verify it actually grounded before trusting it';
  } catch (e) {
    result.tooled = `refused (good): ${(e?.message ?? e).toString().slice(0, 50)}`;
  }

  return result;
};

console.log('\n▶ Candidates for PLAIN_TEXT_MODEL\n');
const rows = [];
for (const model of totest) {
  process.stdout.write(`  testing ${model}…\n`);
  rows.push(await check(model));
}

console.log('\n' + '─'.repeat(96));
for (const r of rows) {
  console.log(`  ${r.model.padEnd(28)} plain: ${r.plain.padEnd(24)} +google_search: ${r.tooled}`);
}
console.log('─'.repeat(96));
console.log(`
  A model that passes "plain" is usable as PLAIN_TEXT_MODEL — advisor answers,
  panel synthesis, cross-library chat and the structuring pass, none of which
  attach a tool.

  Nothing here changes the grounded calls. Scholar search, paper resolution,
  source reading and grounded generation stay on MODELS.text, because grounding
  is the whole point of them.
`);
