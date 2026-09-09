# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm test             # vitest, no network
docker compose up -d db   # Postgres 17 + pgvector on :5432
npm run db:migrate   # apply migrations (also: db:reset to drop and rebuild)
npm run dev:local    # app + API on :3000, pointed at the local database
npm run worker       # queue worker; nothing is processed without one running
npm run dev          # same as dev:local without DATABASE_URL preset
npm run build        # client build -> dist/
npm start            # production server (tsx server/index.ts)
npm run typecheck    # tsc --noEmit
npm run docker:build
```

`npm test` runs Vitest over the pure logic that regressions hide in: authorization
role resolution, the SQL predicate builder, the job retry policy, chunking, RRF
fusion, API-key and session handling, the WAV header, blob-key traversal guards,
`extractText`/`extractJson`, the SSE frame parser, corpus and scholar keys,
citation formatting, and both fail-closed startup guards. It does not touch the
network or a database.

`tests/integration/` needs a real Postgres and is **skipped unless
`TEST_DATABASE_URL` is set** — deliberately not `DATABASE_URL`, because it drops
the schema. It also refuses any URL whose database name does not end in `_test`.

```bash
createdb scholarmind_test
TEST_DATABASE_URL=postgres://…/scholarmind_test npx vitest run tests/integration
```

`scripts/spike-phase0*.mjs` remain the live Gemini contract check;
`scripts/spike-postgres.mjs` checks pgvector, FTS, `SKIP LOCKED`, and **measures
the embedding dimension** (see the migration note below).
`scripts/reconcile-stores.mjs` finds File Search stores no profile references.

`.env` is required — see `.env.example`. `GEMINI_API_KEY` and `DATABASE_URL` are
the two that matter locally.

`curl localhost:3000/api/healthz` reports which backends are live — the fastest
way to diagnose a misconfiguration.

## Architecture

React SPA plus a Hono API. **The browser holds no credentials and no persisted
state.** Postgres stores everything relational — tenancy, ACLs, documents, jobs
and the search index — Cloud Storage (filesystem locally) stores bytes, and every
Gemini call is server-side.

`server/router.ts` is mounted by *both* `vite.config.ts` (via `configureServer`)
and `server/index.ts` (via `@hono/node-server`). One implementation — do not add
a separate dev-only API path.

```
server/
  env.ts          .env loading and the fail-closed startup guards; MUST be imported first
  db.ts           pg pool, query helpers, transaction()
  db/migrate.ts   numbered plain-SQL migrations, applied in order
  router.ts       all endpoints
  identity.ts     who the caller is: API key → session → IAP → dev user
  session.ts      session rows and the sign-in domain policy
  firebaseAuth.ts Firebase ID token verification (no firebase-admin)
  apiKeys.ts      per-user API keys, hashed
  tenancy.ts      which org and team a caller acts in
  authz.ts        the visibility predicate; the only authorization decision
  repository.ts   profiles, papers, messages, corpus, consultations
  blobStore.ts    GCS + filesystem behind one interface
  jobs.ts         the queue: enqueue, claim, retry, dead-letter, runs
  worker.ts       the queue worker process
  crawler.ts      crawler definitions and scheduling
  indexer.ts      chunking, embeddings, writing the search index
  search.ts       hybrid FTS + vector retrieval, ACL-scoped
  advisor.ts      persona prompting and panel fan-out
  gemini.ts       model calls, prompts, schemas, response extraction
  fileSearch.ts   per-profile store lifecycle
  paperSource.ts  open-access PDF resolution
  ingest.ts       per-paper pipeline; `mode` selects index, artifacts, or both
  corpus.ts       cross-profile paper de-duplication; scholar identity keys
  sources.ts      YouTube, web, Wikipedia, uploads → extracted text
  citations.ts    BibTeX/APA/MLA/Chicago/Harvard/RIS + Crossref enrichment
  export.ts       ZIP + pcmToWav
services/api.ts   the browser's only server interface
mcp/server.mjs    MCP server — a client of the HTTP API, not a second one
```

## Constraints that will bite you

These were found by testing live APIs. Each cost a debugging session.

**Grounding tools are mutually exclusive.** File Search composes with neither
Google Search nor URL Context — the API returns `400 'google_search' and
'file_search' cannot be combined in the same request`. Attach exactly one. This
is why chat has a visible toggle instead of inferring intent.

**File Search corrupts structured JSON.** With File Search attached,
`response_format` output reliably breaks at the first array (`"points":.` instead
of `"points": [`), because the citation-insertion pass rewrites the `[`. **Grounded
structured generation must be two calls**: grounded prose first, then structuring
with no tools. `generatePaperResources` does this.

**File Search is unavailable on Vertex AI.** The SDK's types say so, and so are
the citation-carrying grounding fields. The Developer API with an API key is used
in every environment. The gating is runtime-only.

**File Search retrieval cannot be scoped below a store,** and this is why the
search index lives in Postgres. Three findings, all verified live:
- `metadataFilter` only works on the API's *own* recognised keys. An app-defined
  key silently matches **nothing** — same documents, same values, different key name.
- String `customMetadata` values are not filterable at all.
- `fileSearchStoreNames` is an array, but **five stores per call is the hard
  limit** — six returns `400 Invalid input received`.

Under an ACL model the visible set differs per viewer and routinely exceeds five
profiles, so a store boundary cannot express it. **`server/search.ts` puts the
authorization predicate in the same query as the retrieval.** File Search is
retained only for single-profile chat grounding, where the cap is irrelevant.

**`server/env.ts` must be imported first.** ES module imports are evaluated
before module-level statements, so a loader called at the top of an entry file
still runs after imported modules read `process.env`.

**TTS is unreachable via the Interactions API** and stays on `generateContent`.
It returns headerless 24kHz mono PCM (`audio/l16`); the blob endpoint wraps it in
a RIFF header.

**Illustrations are JPEG, not PNG.** Store and serve the real mime type.

**The Interactions API does not accept `parts`.** It takes its own typed content
blocks — `{type:'video'|'audio'|'document', uri, mime_type}` — and a YouTube URL
works as a `video` block directly. Media **does** compose with `response_format`.

**Sources are extracted once, at add time.** `sources.ts` normalises every kind to
`extractedText`; indexing and generation both read that rather than re-fetching.

**Citations never come from the model.** In chat they come from File Search
annotations; in advisors they are the chunks *we* retrieved, which is stronger.
Bibliographic metadata comes only from stored records and Crossref, matched on
exact normalised title.

**Postgres rejects a statement whose parameters go unused.** The ACL predicate
collapses when `ACL_ENABLED=false`, and it must still *reference* its parameter —
hence `($1::text IS NOT NULL)` rather than `TRUE`. The cast is required too, or
the parameter's type cannot be inferred. This shipped broken once, in exactly one
configuration and therefore exactly one environment.

**Deleting an indexed File Search document needs `force: true`.**

**The migration job pins an image.** `gcloud run jobs deploy scholarmind-migrate`
must be updated whenever a migration is added, or it runs an old set and the
service starts against a schema it does not expect. `cloudbuild.yaml` handles
this; a hand-rolled deploy does not. This shipped broken once.

**`{ ...current, ...(await f()) }` snapshots too early.** Object-literal
properties evaluate left to right, so `...current` is copied *before* the await
resolves. `processPaper` binds the patch to a variable first, or every `setStage`
inside a run is silently reverted.

## Conventions

**Authorization is one predicate.** `authz.visibilityPredicate` is used
everywhere; there is no ad-hoc `WHERE owner_id =` in the server. Loading a
resource *is* the check, so an unreachable profile and a missing one are
indistinguishable and both answer 404. Visibility never confers write, and
ownership is not grantable.

**Local runs without ACLs, on the same code path.** `ACL_ENABLED=false` collapses
the predicate; the columns, joins and query shape are identical, so
`ACL_ENABLED=true` locally exercises production exactly.

**Two fail-closed startup guards.** `env.ts` refuses to start on Cloud Run
without `NODE_ENV=production` (every caller would be the same dev user) or
without `AUTH_ALLOWED_DOMAINS` (anyone who can receive email could register and
read every org-visible library). `*` says open registration is deliberate; empty
says it by accident. A crashed revision beats a serving one that is wide open.

**Work outlives the request.** Acquisition, enrichment and indexing are queue
jobs, not request handlers. `POST /profiles/:id/search` and `/process` return
`202 {runId}`; the client polls `/profiles/:id/status` with an ETag. Chat keeps
SSE, where streaming live tokens is correct.

**The job row is the status.** There is no second store to keep in sync. Retries
back off exponentially, spent jobs dead-letter, and a worker that dies mid-job is
reaped by heartbeat.

**Error contracts are load-bearing.** Scholar search re-throws so the UI can
surface it. Citations, speech and illustration return empty. Generation returns a
placeholder rather than throwing, so one bad paper cannot abort a run. One advisor
failing must never abort a panel.

**Everything degrades.** No PDF falls back to URL context, then to search
grounding. **The Postgres index and File Search are written independently** —
a rejected API key must not be able to empty the search index. A paper fails to
index only if it reached neither.

**Bytes never enter React state or the database.** `Paper` carries
`illustrationKey` / `audioKey` / `pdfKey`; `/api/blobs/*` checks the profile ID
embedded in the key against the ACL, so a key alone is not a capability.

**Papers are de-duplicated across profiles and owners, but embeddings are not.**
`server/corpus.ts` caches the resolved source URL and PDF bytes, so the second
profile to index a paper skips resolution and download (10.6s → 5.2s measured).
The corpus is deliberately untenanted: it holds only public open-access content.

**Duplicate scholar libraries are detected, not prevented.** The cheap check runs
request-side and answers `409`. The one needing the resolved name runs in the
crawl job — still before anything is written — and reports by **cancelling** the
run with `detail.duplicate`. Cancelled, not failed: nothing broke.

**Indexing and artifact generation are separate operations,** behind separate
buttons and separate status fields (`indexStatus` vs `status`).

**Advisors ground in published work; they do not impersonate.** The persona
shapes register and standpoint, never facts. The real guardrail is structural,
not textual: an advisor with no relevant passages is **not asked at all** —
`askAdvisor` returns the abstention without a model call. A prompt instruction is
advice; an absent call is a guarantee.

**Secrets are stored hashed.** API keys and session cookies both keep only a
SHA-256, with a clear-text prefix for indexed lookup. A leaked database is not a
set of live credentials.

## Models

`gemini-3.8-flash` (text), `gemini-3.1-flash-image`,
`gemini-3.1-flash-tts-preview`, `gemini-embedding-2`. Defined in `MODELS` in
`server/gemini.ts`.

Text calls use `ai.interactions.create`. Responses have **no `.text`** — output
lives in a `model_output` step as `steps[].content[].text`, alongside a `thought`
step. `extractText` walks this defensively.

`response_format` takes an inline JSON-Schema object, not an OpenAI-style
`json_schema` wrapper.

After an SDK upgrade or model deprecation, run `scripts/spike-phase0.mjs`.

## The embedding dimension

`0004_embeddings.sql` adds `chunks.embedding vector(N)` and is the only migration
that needs a value from outside the repository: the output dimension of
`gemini-embedding-2`, which appears nowhere in the code. **Do not guess it** — a
wrong dimension rejects every insert and correcting it means rebuilding the index.

```bash
GEMINI_API_KEY=… npm run spike:postgres   # check G2 prints it
EMBEDDING_DIM=<n> npm run db:migrate
```

The migration declares itself `-- deferrable`, so until it runs the rest apply
normally and **search degrades to keyword-only**. That degradation is invisible in
tests and obvious in use: queries phrased unlike the source text return little.

## Docs

`docs/architecture` (design reasoning), `docs/development` (local workflow),
`docs/deployment` (GCP), `docs/general/features.md` (user guide), `docs/sdlc`
(process). Plans live in `.claude/plans/`.
