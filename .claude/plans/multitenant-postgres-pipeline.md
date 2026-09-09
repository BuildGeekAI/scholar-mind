# Plan: Multi-tenant ScholarMind on Postgres — org/team/user, ACLs, and an event-driven crawl → download → enrich → index queue

**Status:** TEST complete — 202 unit tests plus a 28-case integration suite, all passing; one Phase 0 measurement outstanding (see log)
**Phase:** IMPLEMENT
**Relates to:** `.claude/plans/gcp-native-scholarmind.md` (the current architecture; this plan replaces its persistence and pipeline layers, and keeps its Gemini findings)

## Requirement

Make ScholarMind multi-tenant — every resource owned by an `org` / `team` / `user`, public by default with optional per-user ACL sharing — persisted in Postgres in both local and GCP environments, with paper acquisition, AI enrichment and indexing moved out of the request path onto a durable job queue that the client polls for per-instance status, and with reusable **crawler** definitions that turn "browse this scholar profile" into a scheduled, consumed event.

---

## Where the code is today

Four facts about the current build determine how big each part of this is.

| Concern | Today | Consequence |
| --- | --- | --- |
| Persistence | Firestore, `server/repository.ts`, `profiles/{id}/papers` + `/messages` subcollections, plus a top-level `corpus` collection | The repository module is the only Firestore caller. Everything else goes through it — so a rewrite is bounded, but every one of its ~20 exports changes shape. |
| Tenancy | None. A single `ownerId` string column and `getProfile(ownerId, id)` returning `null` on mismatch | There is exactly one authorization check in the system and it is an equality test. There is nowhere for org, team, visibility or grants to live. |
| Pipeline | Synchronous. `POST /api/profiles/:id/process` runs `processPapers` inline and streams progress over SSE, so the work lives and dies with the HTTP request | Moving to a queue is not "add a worker" — it is inverting this endpoint from *do the work* to *enqueue and return an id*, and replacing the SSE contract in `services/api.ts` and `ProfileWorkspace.tsx`. |
| Retrieval | Gemini File Search, one store per profile. Per CLAUDE.md and verified live: retrieval cannot be scoped below a store, app-defined metadata filters silently match nothing, and five stores is the hard per-call limit | **This is the reason the search stack has to move.** The per-profile store boundary is currently the isolation mechanism. Under an ACL model the viewer's visible set is a *different* set per viewer and can exceed five profiles, so store-per-profile can no longer express it. Postgres FTS + pgvector can, because the ACL predicate joins into the same query. |

`server/blobStore.ts` is unaffected — bytes stay in GCS / the filesystem behind the same interface, and `blobKey()` keeps embedding the profile id so the ownership check on `/api/blobs/*` survives (it gets a new ACL check, not a new shape).

---

## Decisions

### D1 — Postgres fully replaces Firestore
Confirmed with the user. One store for documents, tenancy, ACLs, jobs and the index. The reasons that matter here:

- **The ACL check and the data it guards must be in one query.** "List every paper visible to me" is a join across users → memberships → grants → profiles → papers. Across two stores it becomes an N+1 in application code, and it cannot be made transactional.
- **The queue wants transactional enqueue.** Writing a paper row and its job row in one transaction is what makes the pipeline exactly-once-ish; across stores it is a dual-write with no recovery story.
- **The index wants the ACL predicate inline.** See D3.

Cloud SQL for PostgreSQL in GCP; a container locally. `npm run emulator` (Firestore, needs Java) is retired in favour of `docker compose up db`.

**Not moving:** blob bytes. GCS in cloud, filesystem locally, unchanged.

### D2 — Tenancy shape: org → team → user, with visibility plus explicit grants
```
orgs ──< teams ──< team_members >── users
  └──< org_members >── users
```
Every ownable resource (`profiles`, and by descent `papers`, `messages`, `crawlers`) carries `org_id NOT NULL`, `team_id NOT NULL`, `owner_id NOT NULL`, and `visibility`.

`visibility` is an enum: `'org' | 'team' | 'private'`. Sharing with named users is *additive* on top, via one polymorphic grants table:

```sql
resource_grants(resource_type, resource_id, principal_type, principal_id, role, granted_by, created_at)
--                                          'user'|'team'|'org'          'viewer'|'editor'|'owner'
```

Effective role for (user, resource) = the strongest of: owner match → `owner`; a matching grant → its role; visibility reachability → `viewer`.

> **Assumption to confirm.** You said "by default, their stuff is public." I have read *public* as **readable by every member of their org**, not readable by the open internet — nothing in the app has an anonymous surface today, and `resolveUser` returns 401 for an unauthenticated caller. Default is therefore `visibility = 'org'`. If you meant genuinely world-readable, that is a fourth enum value plus an unauthenticated read path, and I'd want to plan that separately.

### D3 — The reverse index is Postgres FTS + pgvector, and it is what makes sharing possible
Confirmed with the user. Two new tables:

- `documents` — one row per indexed unit (a paper's full text, a written summary when no PDF resolved, or a source's `extractedText`). Carries a `tsv tsvector GENERATED ALWAYS AS (...) STORED` column with a GIN index.
- `chunks` — the document split for retrieval, each with `embedding vector(N)` and an HNSW index.

Search is hybrid: an FTS query and a vector query, fused with reciprocal-rank fusion, **both filtered by the same ACL predicate** on the joined profile row. That single fact is why this replaces File Search rather than supplementing it — the constraint recorded in CLAUDE.md ("File Search retrieval cannot be scoped below a store", "an app-defined key silently matches nothing") is precisely the thing an ACL model needs and cannot get there.

**Gemini File Search is not deleted in this plan.** It stays as the grounding tool for single-profile chat, because it is what produces the citation-carrying grounding chunks the UI renders. Phase 7 proposes retiring it — with pgvector we know exactly which chunks were passed to the model, so citations become *exact* rather than model-reported, which is strictly better against the repo's own rule that citations never come from the model. That is a real improvement but a real scope increase, so it is a separate phase with its own go/no-go.

Embedding dimension for `gemini-embedding-2` is **not known from the code** — it appears only as a File Search config string, never in an `embedContent` call. Phase 0 spikes it.

### D4 — The queue is Postgres rows claimed with `FOR UPDATE SKIP LOCKED`
Confirmed with the user. One mechanism in both environments, which is the same rule `server/router.ts` already enforces for the API ("one implementation — do not add a separate dev-only API path").

```sql
UPDATE jobs SET status='running', locked_by=$1, locked_at=now(), heartbeat_at=now(), attempts=attempts+1
WHERE id IN (
  SELECT id FROM jobs
  WHERE status='queued' AND run_after <= now()
  ORDER BY priority DESC, run_after
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
RETURNING *;
```

Properties this buys: enqueue in the same transaction as the write that caused it; the job row *is* the status the UI polls, so no second status store; retries with exponential `run_after` backoff; a dead-letter status; and a reaper that requeues rows whose `heartbeat_at` has gone stale (a worker that died mid-job).

Worker is `server/worker.ts`, run as `npm run worker` locally and as a **second Cloud Run service off the same image** with a different entrypoint. Not a Cloud Run *Job* — the queue is long-lived and pull-based, so a min-instance-0 service with a poll loop or a scheduled scale-up fits better than a batch job per unit of work.

### D5 — Local has no ACL, but has exactly the same code path
"Local will not have any acl." Implemented as a single predicate builder:

```ts
// server/authz.ts
export const visibilityPredicate = (user, alias) =>
  ACL_ENABLED ? `(<the real EXISTS/join predicate>)` : 'TRUE';
```

The columns, the joins and the query shape are identical; only the predicate collapses. This is deliberate — an ACL that is *absent* locally and *present* in production is the failure mode where a broken query is only discovered after deploy. With this shape, flipping `ACL_ENABLED=true` locally exercises the production path exactly.

### D6 — Seed tenancy is `demo/demo/demo`
`org: demo`, `team: demo`, `user: demo` created by the first migration. `resolveUser` gains org/team resolution: the API-key user, the dev user and the IAP user all map to a `users` row, defaulting to the demo org/team when no membership exists. Nothing in `identity.ts`'s existing security properties changes — the constant-time key compare, the refusal of a wrong key in every environment, and IAP JWT verification all stay.

### D7 — Browsing a scholar profile becomes an event, not a request
`POST /api/profiles/:id/search` today: calls the model, resolves the scholar, writes papers, returns them. After: validates the duplicate check (which must stay *before* any write — the repo guarantees "a rejected search leaves nothing behind"), creates a `crawl_run`, enqueues a `crawl.profile` job, and returns `202 { runId }`. The crawler job resolves the scholar and fans out one `paper.acquire` job per paper; each of those chains `paper.enrich` and `paper.index`.

`POST /api/profiles/:id/process` loses its SSE body and becomes an enqueue returning `{ runId }`. **SSE for processing is removed** — it is fundamentally incompatible with work that outlives the request, and you asked for polling. SSE stays for `/api/chat`, where streaming a live token response is correct.

### D8 — Job status is a first-class, pollable resource
```
GET /api/runs/:id            → run + rolled-up counts + per-item states
GET /api/profiles/:id/status → per-paper { download, enrich, index } + any active run
```
Both support `ETag`/`If-None-Match` so a 2-second poll is cheap. `Paper` gains explicit per-stage status instead of today's overloaded `status` + `stage` + `indexStatus` + `pdfStatus` spread.

---

## Data model

New enums: `visibility`, `principal_type`, `grant_role`, `job_status`, `job_type`, `run_status`.

```
orgs(id, slug UNIQUE, name, created_at)
users(id, external_id UNIQUE, email UNIQUE, display_name, created_at)
teams(id, org_id→orgs, slug, name, created_at, UNIQUE(org_id, slug))
org_members(org_id, user_id, role, PRIMARY KEY(org_id,user_id))
team_members(team_id, user_id, role, PRIMARY KEY(team_id,user_id))

profiles(id, org_id, team_id, owner_id, title, emoji, theme, visibility DEFAULT 'org',
         scholar_name, affiliation, topics text[], file_search_store_name,
         scholar_keys text[], created_at, updated_at)
papers(id, profile_id→profiles ON DELETE CASCADE, kind, title, year, authors text[],
       summary, citation_count, corpus_key,
       download_status, enrich_status, index_status,      -- replaces status/stage/pdfStatus/indexStatus
       blog_title, blog_content, slides jsonb, quiz jsonb, flash_cards jsonb, audio_script,
       illustration_key, illustration_mime, audio_key, audio_mime, pdf_key, media_key,
       media_mime, file_name, source_url, extracted_text, duration_seconds,
       citation_meta jsonb, file_search_doc_name, indexed_kind, pdf_reused,
       created_at, updated_at,
       UNIQUE(profile_id, id))
messages(id, profile_id→profiles ON DELETE CASCADE, role, content, citations jsonb, created_at)
corpus(key PRIMARY KEY, title, pdf_blob_key, source_url, pdf_status,
       first_seen_at, updated_at, reuse_count)   -- stays cross-tenant by design; public OA content only

resource_grants(id, resource_type, resource_id, principal_type, principal_id, role,
                granted_by, created_at, UNIQUE(resource_type,resource_id,principal_type,principal_id))

crawlers(id, org_id, team_id, owner_id, kind, target, config jsonb,
         schedule_cron, enabled, last_run_at, next_run_at, created_at)
crawl_runs(id, crawler_id NULL, profile_id, org_id, team_id, triggered_by,
           status, totals jsonb, started_at, finished_at, error, created_at)

jobs(id, run_id→crawl_runs NULL, parent_job_id NULL, org_id, team_id, owner_id,
     type, payload jsonb, dedupe_key,
     status, priority, attempts, max_attempts, run_after, locked_by, locked_at,
     heartbeat_at, error, created_at, updated_at)
job_events(id, job_id→jobs ON DELETE CASCADE, at, status, detail jsonb)

documents(id, paper_id→papers ON DELETE CASCADE, profile_id, org_id, team_id,
          source_kind, title, body, tsv tsvector GENERATED ALWAYS AS (...) STORED,
          created_at)
chunks(id, document_id→documents ON DELETE CASCADE, ordinal, text,
       embedding vector(N), token_count)
```

Indexes worth naming up front: `jobs(status, run_after, priority DESC)` partial on `status='queued'`; a **unique partial** `jobs(dedupe_key) WHERE status IN ('queued','running')` so re-enqueueing the same paper is a no-op; `documents USING GIN(tsv)`; `chunks USING hnsw(embedding vector_cosine_ops)`; `papers(profile_id)`; `resource_grants(principal_type, principal_id)`.

`corpus` deliberately stays **outside** the tenancy model, as it is today — CLAUDE.md is explicit that it holds only public open-access content and never anything profile-specific. Adding org columns to it would silently break the cross-profile dedup that saves the resolve-and-fetch (measured 10.6s → 5.2s).

---

## Implementation phases

### [x] Phase 0 — Spike the unknowns (`scripts/spike-postgres.mjs`)
Nothing here is guesswork-safe, and each item costs a rewrite if wrong.

1. `gemini-embedding-2` **output dimension** and whether `ai().models.embedContent` exists and works in `@google/genai` v2.21 — the repo has never called it. Also whether output dimensionality is configurable (it may support truncation, which changes the HNSW index cost).
2. `pgvector` availability on the target Cloud SQL version, and locally via `pgvector/pgvector:pg17`.
3. `pg` connection behaviour from Cloud Run — pool sizing against Cloud SQL's connection limit, and whether the Cloud SQL Node connector or a Unix socket is the right attachment.
4. Confirm `FOR UPDATE SKIP LOCKED` claim throughput with the intended pool size (sanity only).

**Exit criterion:** the embedding dimension is a known number written into the migration, not a placeholder.

### [x] Phase 1 — Postgres foundation
- `docker-compose.yml` — `pgvector/pgvector:pg17`, port 5432, named volume.
- `server/db.ts` — lazily-constructed `pg.Pool`, mirroring how `repository.ts` constructs Firestore lazily so that merely importing the router never reaches for credentials. `DATABASE_URL` from `env.ts` (which still must be imported first).
- `server/db/migrations/0001_init.sql` … numbered plain SQL, applied by a ~40-line runner in `server/db/migrate.ts` against a `schema_migrations` table. No migration framework dependency — matches the repo's low-dependency style.
- `0001` creates the schema above and seeds `demo/demo/demo` (D6).
- Add `pg` and `@types/pg`. Remove `@google-cloud/firestore` and `firebase-tools` at the end of Phase 7, not now.
- `npm run db:migrate`, `npm run db:reset`; `dev:local` gains `DATABASE_URL`; `emulator` script removed.

### [x] Phase 2 — Rewrite `repository.ts` onto Postgres, tenancy-aware
- Same module, same export names where the semantics survive; row↔domain mappers (`snake_case` ↔ the existing camelCase `Paper`/`ProfileRecord`) kept in one place.
- `getProfile(ownerId, id)` becomes `getProfile(ctx, id)` where `ctx = { userId, orgId, teamId }`, and the ownership equality test becomes the D5 predicate.
- **The `withDeletions` / `CLEARABLE` workaround disappears** — the Firestore quirk it exists for ("merge writes cannot clear a field") has no Postgres analogue. Setting a column to `NULL` simply works. Delete it and its comment.
- Likewise the batched `deleteCollection` helper — `ON DELETE CASCADE` replaces it.
- `server/authz.ts` — `resolveContext(user)`, `visibilityPredicate()`, `effectiveRole()`, `assertCan(ctx, resource, 'view'|'edit'|'own')`.
- `identity.ts` gains a `users` upsert-on-first-sight and org/team resolution; its existing auth properties are untouched.
- `router.ts`: replace the `owned()` helper with `viewable()` / `editable()`; add the ACL check to `/api/blobs/*` (today it parses the profile id out of the key and compares to the caller — it now resolves that profile and asks `authz`).

### [x] Phase 3 — Jobs and the worker
- `server/jobs.ts` — `enqueue(tx, job)`, `claim(workerId, n)`, `heartbeat`, `complete`, `fail` (backoff + dead-letter at `max_attempts`), `reapStale()`.
- `server/worker.ts` — poll loop, graceful SIGTERM drain, one handler per `job_type`.
- Handlers wrap the **existing** `server/ingest.ts` functions rather than reimplementing them. `processPaper`'s per-paper logic is already the right unit of work; what changes is that its progress callback writes `job_events` instead of an SSE frame, and its stages map onto the new `download_status` / `enrich_status` / `index_status` columns.
  - Keep the `{ ...current, ...(await f()) }` fix intact — CLAUDE.md records that binding the patch to a variable first is what stops `setStage` being silently reverted.
- Job types: `crawl.profile`, `paper.acquire`, `paper.enrich`, `paper.index`, `source.ingest`.
- `npm run worker`; `Dockerfile` gains a worker entrypoint; `cloudbuild.yaml` deploys a second service.

### [x] Phase 4 — Crawlers and the event flow
- `server/crawler.ts` — a crawler definition resolves a scholar (reusing `searchScholarAndPapers` and `corpus.scholarKeysFor`) and fans out per-paper jobs under one `crawl_run`.
- Rewire `POST /profiles/:id/search` per D7: duplicate check first (unchanged semantics, still `409 {duplicate}`, still nothing written on rejection), then `crawl_run` + job, then `202 {runId}`.
- Rewire `POST /profiles/:id/process` to enqueue and return `{ runId }`; delete its `streamSSE` block.
- CRUD for crawler definitions: `GET/POST/PATCH/DELETE /api/crawlers`, plus `POST /api/crawlers/:id/run`.
- Scheduled crawlers: a `crawler.tick` job requeues itself, or Cloud Scheduler hits an authenticated endpoint. **Recommend the self-requeueing job** — it keeps the one-mechanism property from D4 and works locally with no extra service.

### [x] Phase 5 — The reverse index
- `server/indexer.ts` — chunking (token-budgeted, overlapping), `embedChunks()` batched against `gemini-embedding-2`, upsert into `documents` + `chunks`.
- `server/search.ts` — `search(ctx, query, opts)`: FTS branch + vector branch, RRF fusion, ACL predicate on both, returning chunk + document + paper + profile.
- `GET /api/search?q=…&scope=me|team|org` — the cross-library search that File Search's five-store limit made impossible.
- `paper.index` handler writes both the Postgres index and (for now) the File Search store.

### [x] Phase 6 — Status polling and the UI
- `GET /api/runs/:id`, `GET /api/profiles/:id/status`, both with ETags.
- `services/api.ts`: `processPapers`/`searchScholar` return `{ runId }`; add `pollRun`, `pollProfileStatus`, `search`; delete the SSE frame handling for processing (keep it for chat).
- `ProfileWorkspace.tsx` / `PaperList.tsx`: replace the SSE subscription with a poll hook that backs off when idle and stops on a terminal run status. Per-paper badges render the three explicit statuses.
- New: a sharing control on a profile (visibility selector + add-user-by-email), and a search surface for `GET /api/search`.

### [x] Phase 7 — Retire what is superseded (go/no-go per item)
- Delete `@google-cloud/firestore`, `firebase.json`, `firestore.rules`, `firebase-tools`, the emulator script.
- Decide on retiring File Search for chat in favour of pgvector retrieval + exact citations (D3). Recommended, but it is the one item here that changes user-visible chat behaviour, so it deserves its own decision.
- `/api/import/localstorage` — keep or drop; it targets a browser-storage era that predates even the current build.

---

## Tests

`npm test` must stay network-free and fast; that property is load-bearing in this repo. So:

**Unit (added to the existing suite, no database):**
- `authz.test.ts` — effective-role resolution across owner / visibility / grant / team-grant / org-grant, and the `ACL_ENABLED=false` collapse. This is the highest-value new test in the plan: it is the one place where a bug silently leaks another tenant's data.
- `jobs.test.ts` — state machine as a pure function: backoff schedule, `max_attempts` → dead-letter, stale-lock reap eligibility, dedupe-key behaviour.
- `indexer.test.ts` — chunk boundaries and overlap.
- `search.test.ts` — RRF fusion ranking, as a pure function over two ranked lists.
- `sql.test.ts` — the predicate builder emits the expected SQL text for each scope (cheap, catches accidental `TRUE` in production config).

**Integration (opt-in, skipped unless `DATABASE_URL` is set):** `tests/integration/` — migrations apply cleanly, ACL queries return the right rows for three users across two orgs, concurrent `claim()` from two workers never double-books a job, FTS + vector return results. Guarded with `describe.skipIf(!process.env.DATABASE_URL)` so `npm test` is unchanged for anyone without a database.

**Preserve:** all 113 existing cases. The blob-key traversal guards, WAV header, `extractText`/`extractJson`, corpus keys and citation formatting are untouched by this plan and must stay green.

---

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Retrieval quality regresses** moving off File Search. Its chunking, embedding and citation extraction are tuned; ours will not be on day one. | Phase 5 adds Postgres search *alongside* File Search, not instead of it. Compare on a real profile before Phase 7's go/no-go. |
| R2 | **Unknown embedding dimension** blocks the migration. | Phase 0 exit criterion. Do not write `vector(768)` on a guess. |
| R3 | **ACL bug leaks cross-tenant data.** The single worst outcome in this plan. | One predicate builder, used everywhere; no ad-hoc `WHERE owner_id =` anywhere else; `authz.test.ts`; and `ACL_ENABLED=true` runnable locally so the production path is exercised in development. |
| R4 | **Cloud Run + Cloud SQL connection exhaustion** — many instances × a pool each. | Small `max` per pool, Cloud SQL connector, and the worker as a separate service with its own sizing. Spiked in Phase 0. |
| R5 | **Losing SSE progress feels slower** even when it is not. | Poll at ~2s with ETags while a run is active; `job_events` gives finer-grained detail than the current SSE frames, so the UI can show *more*, not less. |
| R6 | **Big-bang risk** — this touches persistence, auth, the pipeline and retrieval at once. | The phases are ordered so each ends with the app working. Phases 1–2 ship a Postgres app with today's synchronous behaviour; Phase 3–4 move work to the queue; Phase 5 adds search. No phase requires the next to be usable. |
| R7 | **Existing Firestore data.** | Unknown whether any production data exists. If it does, a one-shot `scripts/migrate-firestore-to-postgres.mjs` reading the old collections and writing rows under `demo/demo/demo`. Cheap to write, so plan for it; skip if the answer is "none". |

---

## Docs to update

- `CLAUDE.md` — the Architecture tree, the commands block (`emulator` → `docker compose`), and the constraints section. The File Search retrieval-scoping constraint becomes the *justification* for Postgres search rather than a live limitation; the Firestore merge-write constraint is deleted outright.
- `docs/architecture/README.md` — tenancy model, ACL resolution, queue design, index design.
- `docs/development/README.md` — Postgres setup, migrations, running the worker.
- `docs/deployment/README.md` — Cloud SQL, the second Cloud Run service, connection config.
- `docs/api/README.md` — new endpoints, the `202 {runId}` contract, the polling shapes.
- `docs/general/features.md` — sharing and cross-library search.

---

## Open questions

1. **"Public" — org-wide, or genuinely world-readable?** Planned as org-wide (D2). A public-internet surface is additional scope.
2. **Is there existing Firestore data to migrate?** Determines whether R7's script is written.
3. **Does the MCP server (`mcp/server.mjs`) need tenancy?** It authenticates with the single `SCHOLARMIND_API_KEY` mapping to one user. Under multi-tenancy that user needs an org/team; per-org API keys are a natural follow-on but are not in this plan.


---

## Implementation log

### Phase 0 (partial — one half could not run)
`scripts/spike-postgres.mjs` written and run. **Postgres half: 6/6 pass.** Postgres 17.11,
pgvector 0.8.6, `hnsw` and `ivfflat` both present, a generated `tsvector` column with a GIN
index matches correctly, and 20 concurrent `FOR UPDATE SKIP LOCKED` claimers took 200 rows
with zero double-booking.

**Gemini half: skipped — there is no `.env` in this checkout, so no `GEMINI_API_KEY`.**
The embedding dimension of `gemini-embedding-2` is therefore still unknown, and it was the
stated exit criterion for Phase 0.

**Deviation, to keep the rest unblocked:** `0001_init.sql` creates no vector column. The
`documents` and `chunks` tables, the `vector(N)` column and the HNSW index move into
`0002_index.sql`, written in Phase 5 — which is where they belong anyway, since nothing before
Phase 5 reads them. Nothing is guessed: the number goes in once `G2` in the spike prints it.
Run `GEMINI_API_KEY=... npm run spike:postgres` to get it.

### Deviation — the three per-stage statuses are derived, not stored
The plan said `papers` gains `download_status` / `enrich_status` / `index_status` *replacing*
`status` / `stage` / `pdf_status` / `index_status`. Implemented instead as: the table mirrors
the existing `Paper` fields exactly, and the three-way status is derived in the status endpoint
(Phase 6) from what is already there —

| Derived | From |
| --- | --- |
| `download` | `pdf_status`, plus `stage` in ('resolving','fetching') meaning running |
| `enrich` | `status` ('discovered'→pending, 'processing'→running, 'converted'→done) |
| `index` | `index_status` |

Two reasons. Storing both would be a second source of truth that the pipeline has to keep in
sync on every write, which is exactly the class of bug the `setStage` comment in CLAUDE.md
already documents. And it keeps R6 true — Phases 1–2 leave the app working, because the
existing UI reads the fields it always read.

### Verified after Phase 2 (ACL enforced, `ACL_ENABLED=true`)
Against a second user in the same org, live over HTTP:

| Case | Result |
| --- | --- |
| Another user's `visibility='org'` profile | visible — public by default works |
| Another user's `visibility='private'` profile | 404 |
| Viewer deletes a profile they can see | 404 — ownership is not grantable |
| Viewer writes a paper into a profile they can see | 404 — visibility never confers write |
| After an `editor` grant on the private profile | 200 read, 200 write |
| Non-owner changes sharing | 404 |
| Grant to an address nobody has signed in as | 404 with an explanatory message |

One real bug found and fixed here: with ACLs off the predicate collapsed to the literal `TRUE`,
which left `$1` bound but unreferenced — Postgres rejects that outright (`bind message supplies
1 parameters, but prepared statement requires 0`), and then could not infer the parameter's type
once referenced. It now collapses to `($1::text IS NOT NULL)`, which keeps the call shape
identical in both modes. Worth noting because it is the exact failure D5 predicted: an
ACL-disabled path that diverges from the enabled one breaks in a way only one environment sees.

### Decision taken during implementation — writing chat messages needs `edit`
Reading a shared library's messages needs `view`; appending needs `edit`. A viewer chatting into
someone else's library would otherwise mutate chat history that the owner sees, which is a
surprising side effect of "I shared this with you". The cost is that a view-only collaborator
cannot chat at all. Per-viewer chat threads are the real fix and are not in this plan.

### Phases 3–4 — queue and crawlers, verified live

| Case | Result |
| --- | --- |
| Enqueue via `POST /profiles/:id/process` | `202 {runId, enqueued}` |
| Same request again while in flight | `enqueued: 0`, returns the *original* run id |
| Worker claims and runs | claimed, ran, failed cleanly on the absent API key |
| Retry | requeued with a 30s backoff, `job_events` recorded the reason |
| Attempts exhausted | `dead`, and the run settled to `failed` and closed |
| Worker killed mid-job | reaper requeued it after the stale window |
| SIGTERM | drained in-flight jobs, then exited |

**Bug found and fixed during verification:** the deduped second request created a run holding no
jobs, which then became the profile's "latest run" and masked the one actually working. Empty runs
are now deleted and the response points at the run already doing the work.

**Deviation — no `paper.acquire` job type.** `acquirePdf` is an internal step of `runIndex`;
prising it out means restructuring the ingest pipeline for no user-visible gain, since the
download's progress is already reported through the paper's own `pdfStatus`. Job types are
`crawl.profile`, `paper.index`, `paper.enrich`, `paper.process`, `crawler.tick`.

**Deviation — the second duplicate check moved into the worker.** The cheap check (computable from
the query alone) still answers `409` from the request. The one that catches "G. Hinton" matching an
existing "Geoffrey Hinton" needs the resolved name, which only exists after the model call — so it
now runs in the job, still before anything is written, and reports itself by **cancelling** the run
with `detail.duplicate`. Cancelled rather than failed: nothing broke. The UI converges both paths on
the same prompt.

**Deviation — crawler scheduling is an interval, not cron.** A cron expression needs a parser; the
actual requirement is "every N hours". The tick is a self-requeueing job rather than Cloud Scheduler,
which keeps the one-mechanism property and works locally with nothing else running.

### Phase 5 — the reverse index, verified live

Cross-library ACL-scoped search works, which is the capability the whole plan turns on:

| Case | Result |
| --- | --- |
| `scope=org`, another user's org-visible library | found |
| the same query against their **private** library | not found |
| after an explicit grant on the private library | found |
| after revoking the grant | not found again |
| `scope=me` with no owned indexed content | 0 hits |

Retrieval and the ACL check are one query, so there is no post-filter to forget and no cap on how
many libraries a search spans — the thing five-stores-per-call made impossible.

**Two bugs found, both the same class as the Phase 2 one:** parameters bound but not referenced by
the SQL. The keyword arm carried a stale `$4`, and the scope parameters were bound unconditionally
while only some scopes reference them. `scopeClause` now returns the clause together with the value
it needs, so the two cannot diverge.

**Known gap, and it is the one that decides Phase 7's go/no-go.** The Postgres index holds each
paper's *prose* — title, authors, summary, write-up, slides — not its PDF full text. There is no PDF
text extraction in this codebase, so a paper whose full text went to File Search as bytes is
represented here by its summary. Retiring File Search means either accepting weaker recall on
full-text papers or adding PDF extraction. Measure before deciding.

### Phase 6 — polling replaces the processing stream

`processPapers` and `searchScholar` now return a run id; `ProfileWorkspace` polls
`/profiles/:id/status` every 2s with an ETag (a repeat poll is a 304) and stops on a terminal run.
Chat keeps its SSE stream, where streaming live tokens is still the right thing.

Two consequences worth noting. Progress now counts *settled jobs* rather than inferring completion
from paper fields — a dead-lettered job is done even though its paper never reached `converted`,
which the old derivation would have hung on forever. And a queued-but-unclaimed run counts as busy,
or the UI would look idle for the second before a worker picks it up.

The SSE parser tests moved from `processPapers` onto `streamChat`. The parser they protect is still
in use; the contract they were attached to is not. `processPapers` gained enqueue-contract tests in
their place. 115 tests pass.

### Phase 7 — what was retired

Deleted: `firebase.json`, `firestore.rules`, `@google-cloud/firestore`, `firebase-tools`, the
`emulator` script. `Dockerfile` documents the one-image/two-services split; `cloudbuild.yaml` deploys
`scholarmind-worker` with `--min-instances=1` (a polling worker that scales to zero never drains the
queue) and `--concurrency=1`.

**Not retired: Gemini File Search.** It still grounds single-profile chat and supplies its citations.
The plan made this a separate go/no-go and the full-text gap above is the reason to keep it for now.

### Outstanding

1. **The embedding dimension is still unmeasured** — no `GEMINI_API_KEY` in this checkout. Search is
   fully working keyword-only; `db:migrate` reports `0004_embeddings.sql` as waiting rather than
   failing, and applies it as soon as `EMBEDDING_DIM` is supplied. Verified end to end against a
   scratch database: with `EMBEDDING_DIM=1536` all four migrations apply and the column is
   `vector(1536)`.
2. **Docs are untouched**, by design — `/release` handles them. `CLAUDE.md`, `README.md` and
   `docs/**` still describe Firestore and the emulator and will actively mislead until updated.
3. **Tests named in the plan** (`authz.test.ts`, `jobs.test.ts`, `indexer.test.ts`, `search.test.ts`,
   the opt-in integration suite) are not written — `/test` owns that. The pure functions were written
   to be testable without a database: `effectiveRole`, `backoffSeconds`, `nextStatusAfterFailure`,
   `chunkText`, `fuse`, `visibilityPredicate`.
4. **Open questions from the plan are still open**: whether "public" should ever mean world-readable,
   whether any Firestore data needs migrating, and whether the MCP server needs per-org keys.


---

## Test log

**202 unit tests across 12 files, network-free, 0.5s.** Plus `tests/integration/acl.test.ts` — 28
cases against a real Postgres, skipped unless `TEST_DATABASE_URL` is set.

| File | Cases | What it pins |
| --- | --- | --- |
| `authz.test.ts` | 30 | `effectiveRole` across owner / visibility / grant / team-grant / org-grant, and the `ACL_ENABLED` collapse |
| `sql.test.ts` | 19 | which tables each access mode consults, and the parameter-discipline regression |
| `jobs.test.ts` | 11 | backoff schedule, dead-letter boundary, exactly-`maxAttempts` retries |
| `indexer.test.ts` | 17 | chunk boundaries, overlap, termination, `documentBody` |
| `search.test.ts` | 10 | RRF fusion — agreement beats either arm alone, dedup, symmetry, damping |
| `integration/acl.test.ts` | 28 | the above against real SQL, plus queue concurrency and cascades |

The integration suite requires `TEST_DATABASE_URL` — deliberately **not** `DATABASE_URL`, because it
drops the schema and must never be able to do that to a configured development database. It also
refuses any URL whose database name does not end in `_test`. Verified: pointing it at `scholarmind`
aborts with an explanatory error and touches nothing.

### Three defects found by the tests

**1. Degenerate chunking when overlap ≥ chunk size.** The cursor advanced one character per step, so
1200 characters produced ~1100 chunks. It terminated — nothing hung — but it multiplied the index and
the embedding bill by three orders of magnitude, the kind of failure that appears on an invoice
rather than in a log. Overlap is now clamped to half a chunk.

**2. Chunks split mid-word.** With no paragraph or sentence break in range the cut landed at exactly
`size`, turning `tok123` into `tok1` + `23` — a token that then matches nothing in either half,
degrading the keyword index and the embedding alike. Whitespace is now the last fallback in the
boundary cascade.

**3. Order-dependent test, not a defect:** the reaper case claimed a job left queued by an earlier
test. Fixed in the test.

### The defect found by manual verification, which was the serious one

Running the app end to end with **no `GEMINI_API_KEY`** showed a paper reaching `index: error` and
zero rows in `chunks`. Two independent couplings, both wrong:

- The worker threw `Could not create a search index.` when File Search store creation failed, before
  `processPaper` ran at all. So the Postgres index — the one that exists *because* File Search cannot
  express an ACL-scoped query — was gated on File Search being reachable. A rejected API key would
  have silently emptied search.
- `acquirePdf` was unguarded, so a throwing resolver aborted indexing entirely, contradicting the
  repo's own stated rule that "a missing artifact must never block a paper."

Both fixed: `runIndex` now writes Postgres **first**, treats the two indexes as independent, and only
reports `error` when a paper reached neither; acquisition failure degrades to summary indexing.
Re-verified with no API key present — `download: unavailable`, `index: done`, run `succeeded`, and the
paper is returned by `/api/search`. Pinned by two integration cases so the coupling cannot return.

### Manual verification performed

Server plus worker, `ACL_ENABLED=true`, fresh schema:

| Surface | Checked |
| --- | --- |
| `GET /api/healthz` | reports database reachability and whether ACLs are enforced; 503 when unreachable |
| `POST /api/profiles` → `PUT .../papers/:id` → `POST .../process` | `202 {runId}`; second identical call returns the *same* run with `enqueued: 0` |
| `GET /api/profiles/:id/status` | per-paper download/enrich/index; repeat poll returns `304` via ETag |
| `GET /api/search` | scopes `me`/`team`/`org`/`profile` all execute; results follow grants |
| `GET/POST/DELETE /api/profiles/:id/sharing` | owner-only; unknown address refused with a usable message |
| `POST /api/crawlers`, `POST /api/crawlers/:id/run` | definition created, manual run enqueued |
| Worker lifecycle | claim → retry with backoff → dead-letter → run settles `failed`; stale job reaped; SIGTERM drains |
| Migrations | `--reset` then apply from scratch; `0004` waits for `EMBEDDING_DIM` and applies cleanly when given one |

### Still untested

- **Anything requiring a live Gemini key**: the crawl handler's model call, artifact generation,
  embeddings, and therefore the entire semantic arm of search. The keyword arm is fully tested; `fuse`
  is tested with synthetic inputs from both arms.
- **The React components.** `ProfileWorkspace`'s poll loop was verified by driving the API it calls,
  not by rendering it. The repo has no component-test harness and the plan did not add one.
- **`0004_embeddings.sql` against real vectors** — applied and asserted structurally with a supplied
  dimension, never populated.
