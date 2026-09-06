#!/usr/bin/env node
/**
 * Finds File Search stores that no profile references any more.
 *
 * Store deletion on profile delete is best-effort by design — a failure there
 * must not block the user — so failures leak stores that count against project
 * quota and cost embeddings storage forever. This reconciles the two sides.
 *
 *   node scripts/reconcile-stores.mjs            # report only
 *   node scripts/reconcile-stores.mjs --delete   # actually delete the orphans
 *
 * Reads the same environment as the server. Against the emulator, set
 * FIRESTORE_EMULATOR_HOST and GOOGLE_CLOUD_PROJECT exactly as `npm run dev:local` does.
 */
import { Firestore } from '@google-cloud/firestore';
import { GoogleGenAI } from '@google/genai';

try {
  process.loadEnvFile();
} catch {
  // Ambient environment only; matches server/env.ts.
}

const apply = process.argv.includes('--delete');
const prefix = process.env.FILE_SEARCH_STORE_PREFIX || '';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = new Firestore({
  ignoreUndefinedProperties: true,
  projectId:
    process.env.GOOGLE_CLOUD_PROJECT ||
    (process.env.FIRESTORE_EMULATOR_HOST ? 'scholarmind-local' : undefined),
});

const referenced = new Set();
const profiles = await db.collection('profiles').get();
for (const doc of profiles.docs) {
  const name = doc.data().fileSearchStoreName;
  if (name) referenced.add(name);
}

const stores = [];
for await (const store of await ai.fileSearchStores.list()) stores.push(store);

/**
 * Only stores this app created are ever considered, matched by the display-name
 * convention. A store belonging to something else in the same project must
 * never be deleted by this script.
 */
const ours = stores.filter(s => (s.displayName || '').startsWith(`${prefix}scholarmind-`));
const foreign = stores.length - ours.length;
const orphans = ours.filter(s => !referenced.has(s.name));

console.log(`profiles referencing a store: ${referenced.size}`);
console.log(`stores in project:            ${stores.length} (${ours.length} ours, ${foreign} not ours)`);
console.log(`orphaned:                     ${orphans.length}`);

if (!orphans.length) {
  console.log('\nNothing to do.');
  process.exit(0);
}

for (const store of orphans) {
  console.log(`  ${store.name}  ${store.displayName ?? ''}`);
}

if (!apply) {
  console.log('\nDry run. Re-run with --delete to remove these.');
  process.exit(0);
}

let deleted = 0;
for (const store of orphans) {
  try {
    await ai.fileSearchStores.delete({ name: store.name, config: { force: true } });
    deleted++;
    console.log(`deleted ${store.name}`);
  } catch (e) {
    console.error(`FAILED  ${store.name}: ${e?.message ?? e}`);
  }
}
console.log(`\ndeleted ${deleted} of ${orphans.length}`);
