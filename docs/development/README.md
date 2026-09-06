# Development

## Setup

Node 22+, Java 11+ (for the Firestore emulator), and a [Google AI Studio key](https://aistudio.google.com/apikey).

```bash
npm install
cp .env.example .env     # add GEMINI_API_KEY
```

`.env` is git-ignored. `.env.example` documents every variable the code reads.

## Running

```bash
npm run emulator     # terminal 1 — Firestore emulator on :8085
npm run dev:local    # terminal 2 — app on :3000
```

`npm run dev:local` sets `FIRESTORE_EMULATOR_HOST` and a placeholder project so no GCP project is needed.

Confirm configuration:

```bash
curl localhost:3000/api/healthz
{"ok":true,"geminiKey":"configured","firestore":"emulator","blobs":"filesystem"}
```

`geminiKey: "MISSING"` means `.env` is absent or the key is empty. The server also warns loudly at startup.

### Port conflicts

If something else holds port 3000 — a Docker container publishing `127.0.0.1:3000` will silently shadow Vite's bind — use another port:

```bash
npm run dev:local -- --port 5180
```

## What runs where

| Concern | Local default | Production |
| :--- | :--- | :--- |
| Documents | Firestore emulator | Firestore |
| Blobs | `./.data/blobs` | Cloud Storage |
| Identity | stub `dev-user` | IAP assertion |
| Secrets | `.env` | Secret Manager |
| Gemini + File Search | **real API** | real API |

**There is no File Search emulator.** Retrieval always hits the real API and creates real stores that cost embedding tokens at indexing time. Set `FILE_SEARCH_STORE_PREFIX=dev-` so local stores are identifiable, and clean them up periodically.

### Running against real GCP services

To exercise Firestore and Cloud Storage rather than emulators:

```bash
gcloud auth application-default login
```

Then unset `FIRESTORE_EMULATOR_HOST` and set `GOOGLE_CLOUD_PROJECT` and `GCS_BUCKET` in `.env`. Use a development project — the app writes real data.

## Layout

```
server/
  env.ts          .env loading — must be imported first (see below)
  router.ts       every HTTP endpoint
  repository.ts   Firestore access
  blobStore.ts    GCS and filesystem implementations of one interface
  identity.ts     IAP assertion verification
  gemini.ts       model calls, prompts, schemas, response extraction
  fileSearch.ts   per-profile retrieval store lifecycle
  paperSource.ts  open-access PDF resolution
  ingest.ts       the per-paper pipeline
  export.ts       ZIP building, PCM→WAV
  index.ts        production entry
services/api.ts   the browser's only server interface
```

### `server/env.ts` must be imported first

ES module imports are evaluated before module-level statements, so calling a loader at the top of `index.ts` still runs *after* imported modules have read `process.env`. `env.ts` is a side-effect module imported first in both entry points. Keep it that way.

## Conventions

**Errors are contracts.** Scholar search re-throws so the UI can surface it. Citations, speech, and illustration return empty on failure. Generation returns a placeholder rather than throwing, so one bad paper cannot abort a run. Callers depend on this.

**Grounding is exclusive.** File Search composes with neither Google Search nor URL Context. Attach exactly one.

**Structured output needs its own call.** File Search corrupts JSON, so grounded structured generation is two stages: grounded prose, then structuring with no tools. See [architecture](../architecture/README.md#2-file-search-corrupts-structured-json).

**Bytes never reach React state.** Blobs go to the blob store; `Paper` carries keys. Store the real mime type — illustrations are JPEG, not PNG.

## Typechecking

```bash
npm run typecheck
```

No test runner is configured yet. See [sdlc](../sdlc/README.md#test).

## Verification spikes

`scripts/spike-phase0.mjs` and `spike-phase0b.mjs` probe the live API for the behaviour this codebase depends on: model availability, tool composition, `response_format` shape, and interaction step structure.

```bash
node scripts/spike-phase0.mjs             # read-only
node scripts/spike-phase0b.mjs            # creates and deletes a File Search store
```

Run them after an SDK upgrade or when a model is deprecated. They fail loudly if an assumption has changed.

## Debugging

- **Server logs** appear in the Vite terminal — the API runs in that process.
- **`[extractJson] unparseable output`** means the model returned malformed JSON. Check whether a grounding tool was attached alongside `response_format`.
- **Empty generated content** usually means `extractText` did not find the `model_output` step. Interaction shape is `steps[].content[].text`.
- **`/api/healthz`** reports which backends are actually in use.
