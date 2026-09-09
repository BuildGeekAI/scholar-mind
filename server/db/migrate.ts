import '../env';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool, transaction } from '../db';

/**
 * Numbered plain-SQL migrations, applied in filename order inside a
 * transaction each. No migration framework: the repository's dependency budget
 * is deliberately small, and forty lines buys everything a framework would.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Substitutes `${VAR}` from the environment. Used by exactly one migration — the
 * embedding column, whose dimension is a property of the model rather than of
 * this repository and must be measured before it can be written down.
 *
 * An unset variable *skips* the migration rather than guessing a value: a wrong
 * vector dimension rejects every insert, and correcting it later means
 * rebuilding the index. Skipping is safe because search degrades to keyword-only
 * without the column, which is the same rule the ingest pipeline follows.
 */
const MISSING = Symbol('missing');
const RAW = Symbol('raw');

/** Declared by a leading `-- deferrable` line. */
const deferrable = (sql: string): boolean => /^\s*--\s*deferrable\s*$/m.test(sql);

const expand = (sql: string): string | { [MISSING]: string[]; [RAW]: string } => {
  const missing: string[] = [];
  const expanded = sql.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
      return '';
    }
    return value;
  });
  return missing.length ? { [MISSING]: missing, [RAW]: sql } : expanded;
};

const ensureTable = async (): Promise<void> => {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
};

export const pending = async (): Promise<string[]> => {
  await ensureTable();
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const { rows } = await pool().query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map(r => r.name));
  return files.filter(f => !applied.has(f));
};

export interface MigrateResult {
  applied: string[];
  /** Migrations that could not run yet, and what each is waiting for. */
  skipped: Array<{ name: string; needs: string[] }>;
}

export const migrate = async (): Promise<MigrateResult> => {
  const todo = await pending();
  const applied: string[] = [];
  const skipped: MigrateResult['skipped'] = [];

  for (const name of todo) {
    const sql = expand(await fs.readFile(path.join(dir, name), 'utf8'));

    if (typeof sql !== 'string') {
      skipped.push({ name, needs: sql[MISSING] });

      // A migration that declares itself deferrable can be passed over: it is
      // one nothing later depends on. Anything else stops the run, because
      // applying a later migration first would leave the schema in an order
      // these files do not describe.
      if (deferrable(sql[RAW])) continue;
      break;
    }

    // Each migration is one transaction, so a failure leaves no half-applied
    // schema and the same command can simply be run again.
    await transaction(async tx => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    console.log(`  ✓ ${name}`);
    applied.push(name);
  }

  return { applied, skipped };
};

/** Drops and recreates the schema. Development only, and it says so. */
export const reset = async (): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset the schema with NODE_ENV=production.');
  }
  await pool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('  ✓ schema dropped');
};

const isEntry = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isEntry) {
  const run = async () => {
    if (process.argv.includes('--reset')) await reset();
    const { applied, skipped } = await migrate();
    console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Already up to date.');

    for (const { name, needs } of skipped) {
      console.log(
        `\n  ⏭  ${name} is waiting for ${needs.join(', ')}.\n` +
          `     Search runs keyword-only until it is applied. To enable semantic search:\n` +
          `       GEMINI_API_KEY=... npm run spike:postgres     # check G2 prints the dimension\n` +
          `       EMBEDDING_DIM=<that number> npm run db:migrate\n`
      );
    }
  };
  run()
    .catch(e => {
      console.error(`Migration failed: ${e.message}`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
