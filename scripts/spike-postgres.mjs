/**
 * Phase 0 spike for the multi-tenant Postgres plan.
 * Run:  DATABASE_URL=... GEMINI_API_KEY=... node scripts/spike-postgres.mjs
 *
 * Two independent halves, each skipped when its credential is absent:
 *   - Postgres: pgvector availability, the SKIP LOCKED claim, FTS.
 *   - Gemini:   the embedding dimension of gemini-embedding-2, which is the
 *               number that has to go into the chunks table. It appears nowhere
 *               in the codebase today (only as a File Search config string), so
 *               it must be measured rather than assumed.
 */
import pg from 'pg';

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

const skip = (name, why) => {
  results.push([name, 'SKIP', why]);
  console.log(`\n▶ ${name}\n  ⏭  ${why}`);
};

// --- Postgres ---------------------------------------------------------------
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  skip('P* postgres checks', 'DATABASE_URL unset — start the database with `docker compose up -d db`');
} else {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  await run('P1 server version', async () => {
    const { rows } = await pool.query('SHOW server_version');
    return rows[0].server_version;
  });

  await run('P2 pgvector is installable', async () => {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    const { rows } = await pool.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
    );
    if (!rows.length) throw new Error('extension created but not present');
    return `vector ${rows[0].extversion}`;
  });

  await run('P3 hnsw index type exists', async () => {
    const { rows } = await pool.query(`SELECT amname FROM pg_am WHERE amname IN ('hnsw','ivfflat')`);
    const names = rows.map(r => r.amname);
    if (!names.includes('hnsw')) throw new Error(`no hnsw access method (have: ${names.join(',') || 'none'})`);
    return names.join(', ');
  });

  await run('P4 generated tsvector column + GIN index', async () => {
    await pool.query('DROP TABLE IF EXISTS spike_docs');
    await pool.query(`
      CREATE TABLE spike_docs (
        id bigserial PRIMARY KEY,
        title text NOT NULL,
        body text NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(body, '')), 'B')
        ) STORED
      )`);
    await pool.query('CREATE INDEX spike_docs_tsv ON spike_docs USING GIN (tsv)');
    await pool.query(
      `INSERT INTO spike_docs (title, body) VALUES
         ('Attention Is All You Need', 'The dominant sequence transduction models are based on recurrent networks.'),
         ('Deep Residual Learning', 'Deeper neural networks are more difficult to train.')`
    );
    const { rows } = await pool.query(
      `SELECT title, ts_rank(tsv, q) AS rank FROM spike_docs, websearch_to_tsquery('english', $1) q
       WHERE tsv @@ q ORDER BY rank DESC`,
      ['recurrent networks']
    );
    if (rows.length !== 1) throw new Error(`expected 1 hit, got ${rows.length}`);
    await pool.query('DROP TABLE spike_docs');
    return `matched "${rows[0].title}"`;
  });

  await run('P5 FOR UPDATE SKIP LOCKED never double-books', async () => {
    await pool.query('DROP TABLE IF EXISTS spike_jobs');
    await pool.query(`
      CREATE TABLE spike_jobs (
        id bigserial PRIMARY KEY,
        status text NOT NULL DEFAULT 'queued',
        locked_by text
      )`);
    await pool.query(`INSERT INTO spike_jobs (status) SELECT 'queued' FROM generate_series(1, 200)`);

    const claim = async worker => {
      const { rows } = await pool.query(
        `UPDATE spike_jobs SET status = 'running', locked_by = $1
         WHERE id IN (
           SELECT id FROM spike_jobs WHERE status = 'queued'
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10
         )
         RETURNING id`,
        [worker]
      );
      return rows.map(r => r.id);
    };

    // Twenty concurrent claims against 200 rows: every row claimed exactly once.
    const claimed = (await Promise.all(
      Array.from({ length: 20 }, (_, i) => claim(`w${i}`))
    )).flat();
    const unique = new Set(claimed);
    if (unique.size !== claimed.length) {
      throw new Error(`double-booked: ${claimed.length} claims, ${unique.size} distinct`);
    }
    await pool.query('DROP TABLE spike_jobs');
    return `${claimed.length} claims, all distinct`;
  });

  await run('P6 pool sizing headroom', async () => {
    const { rows } = await pool.query(
      `SELECT setting::int AS max_conn FROM pg_settings WHERE name = 'max_connections'`
    );
    return `max_connections=${rows[0].max_conn}`;
  });

  await pool.end();
}

// --- Gemini -----------------------------------------------------------------
// The Phase 0 exit criterion: a known dimension, not a guess.
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  skip('G* embedding checks', 'GEMINI_API_KEY unset — the chunks.embedding dimension stays unknown');
} else {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const MODEL = 'gemini-embedding-2';

  await run('G1 embedContent exists on the v2 client', async () => {
    const kind = typeof ai.models?.embedContent;
    if (kind !== 'function') throw new Error(`ai.models.embedContent is ${kind}`);
    return 'function';
  });

  await run('G2 embedding dimension', async () => {
    const r = await ai.models.embedContent({ model: MODEL, contents: 'the quick brown fox' });
    const vector = r?.embeddings?.[0]?.values ?? r?.embedding?.values;
    if (!Array.isArray(vector)) {
      throw new Error(`no vector in response; keys: ${Object.keys(r ?? {}).join(', ')}`);
    }
    console.log(`  >>> WRITE THIS INTO THE MIGRATION: vector(${vector.length})`);
    return `${vector.length} dimensions`;
  });

  await run('G3 output dimensionality is configurable', async () => {
    const r = await ai.models.embedContent({
      model: MODEL,
      contents: 'the quick brown fox',
      config: { outputDimensionality: 768 },
    });
    const vector = r?.embeddings?.[0]?.values ?? r?.embedding?.values;
    if (!Array.isArray(vector)) throw new Error('no vector returned');
    return vector.length === 768
      ? 'yes — truncation supported, so the index cost is ours to choose'
      : `ignored, got ${vector.length}`;
  });

  await run('G4 batching: many texts in one call', async () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta'];
    const r = await ai.models.embedContent({ model: MODEL, contents: texts });
    const n = r?.embeddings?.length ?? 0;
    if (n !== texts.length) throw new Error(`sent ${texts.length}, got ${n} embeddings`);
    return `${n} embeddings in one call`;
  });

  await run('G5 task type affects the vector', async () => {
    const doc = await ai.models.embedContent({
      model: MODEL, contents: 'retrieval corpus text', config: { taskType: 'RETRIEVAL_DOCUMENT' },
    });
    const query = await ai.models.embedContent({
      model: MODEL, contents: 'retrieval corpus text', config: { taskType: 'RETRIEVAL_QUERY' },
    });
    const a = doc?.embeddings?.[0]?.values ?? [];
    const b = query?.embeddings?.[0]?.values ?? [];
    const same = a.length === b.length && a.every((v, i) => v === b[i]);
    return same
      ? 'taskType made no difference — index and query can share one call shape'
      : 'taskType changes the vector — index with RETRIEVAL_DOCUMENT, search with RETRIEVAL_QUERY';
  });
}

// --- Summary ----------------------------------------------------------------
console.log('\n' + '─'.repeat(78));
for (const [name, status, detail] of results) {
  const mark = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭ ' : '❌';
  console.log(`${mark} ${name.padEnd(46)} ${detail}`);
}
const failed = results.filter(r => r[1] === 'FAIL').length;
const skipped = results.filter(r => r[1] === 'SKIP').length;
console.log('─'.repeat(78));
console.log(`${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
