# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm test             # vitest, no network
npm run emulator     # Firestore emulator on :8085 (needs Java)
npm run dev:local    # app + API on :3000, pointed at the emulator
npm run dev          # same without emulator env (uses real Firestore via ADC)
npm run build        # client build -> dist/
npm start            # production server (tsx server/index.ts)
npm run typecheck    # tsc --noEmit
npm run docker:build
```

`npm test` runs Vitest over the pure logic that regressions hide in: the WAV header, blob-key traversal guards, `extractText`/`extractJson` against recorded Interactions shapes, the SSE frame parser, the corpus key, and the fail-closed startup guard. It does not touch the network. `scripts/spike-phase0*.mjs` remain the live-API contract check, and `scripts/reconcile-stores.mjs` finds File Search stores no profile references any more.

`.env` is required — see `.env.example`. Only `GEMINI_API_KEY` is strictly needed; the local set also wants `FIRESTORE_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, and `FILE_SEARCH_STORE_PREFIX`.

`curl localhost:3000/api/healthz` reports which backends are live — the fastest way to diagnose a misconfiguration.

## Architecture

React SPA plus a Hono API. **The browser holds no credentials and no persisted state.** Firestore stores documents, Cloud Storage (filesystem locally) stores bytes, and every Gemini call is server-side.

`server/router.ts` is mounted by *both* `vite.config.ts` (via `configureServer`) and `server/index.ts` (via `@hono/node-server`). One implementation — do not add a separate dev-only API path.

```
server/
  env.ts          .env loading; MUST be imported first
  router.ts       all endpoints
  repository.ts   Firestore: profiles/{id}/papers, /messages as subcollections
  blobStore.ts    GCS + filesystem behind one interface
  identity.ts     IAP JWT verification
  gemini.ts       model calls, prompts, schemas, response extraction
  fileSearch.ts   per-profile store lifecycle
  paperSource.ts  open-access PDF resolution
  ingest.ts       per-paper pipeline; `mode` selects index, artifacts, or both
  corpus.ts       cross-profile paper de-duplication
  export.ts       ZIP + pcmToWav
services/api.ts   the browser's only server interface
```

## Constraints that will bite you

These were found by testing the live API. Each cost a debugging session.

**Grounding tools are mutually exclusive.** File Search composes with neither Google Search nor URL Context — the API returns `400 'google_search' and 'file_search' cannot be combined in the same request`. Attach exactly one. This is why chat has a visible toggle instead of inferring intent.

**File Search corrupts structured JSON.** With File Search attached, `response_format` output reliably breaks at the first array (`"points":.` instead of `"points": [`), because the citation-insertion pass rewrites the `[`. The response is complete and otherwise well-formed, so it is model-side corruption, not a parse bug. **Grounded structured generation must be two calls**: grounded prose first, then structuring with no tools. `generatePaperResources` does this.

**File Search is unavailable on Vertex AI.** The SDK's types say so, and so are the citation-carrying grounding fields. The Developer API with an API key is used in every environment. The gating is runtime-only — clients construct fine under `vertexai: true` and fail at call time.

**`server/env.ts` must be imported first.** ES module imports are evaluated before module-level statements, so a loader called at the top of an entry file still runs after imported modules read `process.env`.

**TTS is unreachable via the Interactions API** and stays on `generateContent`. It returns headerless 24kHz mono PCM (`audio/l16`); the blob endpoint wraps it in a RIFF header so the browser gets playable WAV.

**Illustrations are JPEG, not PNG.** Store and serve the real mime type — the old code hard-coded `data:image/png`.

**File Search retrieval cannot be scoped below a store.** Three findings, all verified live:
- `metadataFilter` only works on the API's *own* recognised keys. `year=2017` filters correctly; an app-defined key (string **or** numeric) silently matches **nothing** — same documents, same values, different key name. A malformed filter 400s, so the filter is being parsed; it just never matches.
- String `customMetadata` values are not filterable at all, in any syntax tried.
- `fileSearchStoreNames` is an array, and attaching a subset works exactly, but the limit is under ten stores per call (5 passes, 10 returns `400 Invalid input received`).

Together these mean one shared index cannot be filtered down to one profile's papers. **The per-profile store boundary is the isolation mechanism** — do not replace it with a filter.

**Deleting an indexed document needs `force: true`.** Without it the API returns `400 'Cannot delete non-empty Document'` — the chunks it was split into count as children. Same shape as store deletion.

**Firestore merge writes cannot clear a field.** `ignoreUndefinedProperties` makes the client drop undefined keys, so `set({stage: undefined}, {merge:true})` leaves the old value in place. `repository.withDeletions` maps the pipeline's transient fields to `FieldValue.delete()`.

**`{ ...current, ...(await f()) }` snapshots too early.** Object-literal properties evaluate left to right, so `...current` is copied *before* the await resolves — any mutation `f` made to `current` in the meantime is discarded. `processPaper` binds the patch to a variable first, or every `setStage` inside a run is silently reverted.

## Conventions

**Error contracts are load-bearing.** Scholar search re-throws so the UI can surface it. Citations, speech, and illustration return empty. Generation returns a placeholder rather than throwing, so one bad paper cannot abort a run. Preserve these.

**Everything degrades.** No PDF falls back to URL context, then to search grounding. A missing artifact must never block a paper.

**Bytes never enter React state or Firestore.** `Paper` carries `illustrationKey` / `audioKey` / `pdfKey`; `/api/blobs/*` checks ownership against the profile ID embedded in the key, so a key alone is not a capability.

**Papers are de-duplicated across profiles and owners, but embeddings are not.** `server/corpus.ts` keys papers by normalized title and caches the resolved source URL and the PDF bytes, so the second profile to index a paper skips resolution and download (10.6s → 5.2s measured). The embedding is repeated per profile because of the retrieval constraint above. The corpus holds only public open-access content — never anything profile-specific.

**Indexing and artifact generation are separate operations,** behind separate buttons and separate status fields (`indexStatus` vs `status`). Indexing is seconds and is what chat needs; generation is a minute and is what reading needs. Neither may clobber the other's state.

**One paper per Firestore document.** Papers and messages are subcollections. The pre-rewrite design kept everything in one profile object, so editing a title rewrote the whole library.

## Models

`gemini-3.8-flash` (text), `gemini-3.1-flash-image`, `gemini-3.1-flash-tts-preview`, `gemini-embedding-2`. Defined in `MODELS` in `server/gemini.ts`.

Text calls use `ai.interactions.create`. Responses have **no `.text`** — output lives in a `model_output` step as `steps[].content[].text`, alongside a `thought` step. `extractText` walks this defensively because the SDK's Interactions types are autogenerated and weakly typed.

`response_format` takes an inline JSON-Schema object (`{type:'object', properties:{...}}`), not an OpenAI-style `json_schema` wrapper.

After an SDK upgrade or model deprecation, run `scripts/spike-phase0.mjs` — it fails loudly if any of this has changed.

## Docs

`docs/architecture` (design reasoning), `docs/development` (local workflow), `docs/deployment` (GCP), `docs/general/features.md` (user guide), `docs/sdlc` (process). Plans live in `.claude/plans/`.
