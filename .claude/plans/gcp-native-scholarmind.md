# Plan: GCP-native ScholarMind — server-persisted state, URL Context ingestion, File Search RAG

**Status:** Phases 0-6 implemented and verified locally. Phase 7 artifacts written and the image builds; GCP provisioning still to run against a real project.
**Phase:** PLAN → IMPLEMENT
**Supersedes:** `local-first-and-gcp.md` (deleted — server-persisted state and File Search invalidated its core decisions)

## Requirement

Rebuild ScholarMind on GCP technology with state persisted server-side rather than in the browser, using the latest Gemini models, the **URL Context** tool to ingest papers, **Cloud Storage** to hold the artifacts, and the **File Search** tool to provide retrieval — with a local development path that exercises the same code.

---

## Research findings that changed the plan

Three findings from the current Gemini documentation overturn decisions in the previous draft. They are the reason this plan looks different, and each is worth understanding before reading the phases.

### F1 — File Search is NOT available on Vertex AI
File Search works only through the **Gemini Developer API** (API-key auth). Vertex AI's equivalent is **RAG Engine**, a different API with a different resource model (corpora, `import_files_async`) — though it *does* import directly from `gs://`.

**This reverses the previous plan's decision to authenticate via Vertex + ADC.** Since you want the files utility for search, production must use the Developer API with a key. The key lives in Secret Manager and is read server-side only, so the original security goal — no credential in the browser — still holds completely. The thing lost is "no key anywhere," which was a nicety, not the requirement.

### F2 — File Search cannot be combined with Google Search or URL Context in the same call
This is a hard constraint and it dictates the pipeline shape. The app currently attaches `googleSearch` to **every** call, including chat. That has to be split into stages:

| Stage | Tool | Purpose |
| --- | --- | --- |
| Discover | `google_search` | Find the scholar, papers, and candidate PDF URLs |
| Ingest | `url_context` | Read the paper itself (PDF supported) |
| Generate / Chat | `file_search` | Ground answers in the indexed corpus |

The consequence worth deciding on: **chat can ground in your library or search the live web, but not both in one call.** Today's bot does both. See D5.

### F3 — The Interactions API is now the recommended surface
`ai.interactions.create` is GA as of June 2026 and recommended for new projects; `generateContent` remains fully supported. It adds server-side conversation state via `previous_interaction_id`, which removes the need to resend chat history and improves cache hits — directly useful here.

Requires **`@google/genai` v2.3.0+**. The repo pins `^1.39.0`, so this is a **major version bump with breaking changes**.

### F4 — Current model IDs
The repo's models are two generations behind.

| Role | Current (repo) | Latest | Notes |
| --- | --- | --- | --- |
| Text / reasoning | `gemini-3-flash-preview` | **`gemini-3.8-flash`** | Stable; most intelligent Flash |
| Image | `gemini-2.5-flash-image` | **`gemini-3.1-flash-image`** | Nano Banana 2; `gemini-3-pro-image` for 4K if cover art warrants it |
| TTS | `gemini-2.5-flash-preview-tts` | **`gemini-3.1-flash-tts-preview`** | Still preview |
| Embeddings | — | **`gemini-embedding-2`** | For the File Search store; multimodal |

---

## Phase 0 spike results (verified 2026-09-05, `@google/genai` 2.21.0)

Run via `scripts/spike-phase0.mjs`. Static checks plus live API calls against the Developer API.

### Confirmed
| # | Finding | Impact |
| --- | --- | --- |
| R1 | **The v1→v2 SDK bump does not break existing code.** `npx tsc --noEmit` exits 0 against 2.21.0 | The plan's top risk is largely retired. `generateContent` still works, so the Interactions migration can be incremental rather than big-bang |
| R2 | All four model IDs resolve: `gemini-3.8-flash`, `gemini-3.1-flash-image`, `gemini-3.1-flash-tts-preview`, `gemini-embedding-2` | F4 stands |
| R3 | **F2 confirmed for Google Search**, verbatim: `400 'google_search' and 'file_search' cannot be combined in the same request` | D5's chat toggle is necessary |
| R4 | `url_context` successfully reads `arxiv.org/pdf/1706.03762` | Ingestion path (D3) works; no proxy needed |
| R5 | **F1 confirmed from the SDK's own types**, `genai.d.ts:4735`: the FileSearch tool "is not supported in Vertex AI". Grounding-chunk fields — store name, media blob, page number — are likewise Vertex-unsupported, so **citations do not work on Vertex either** | D2 (Developer API in both environments) is correct and now evidence-backed |
| R6 | Vertex gating is **runtime-only** — both `interactions` and `fileSearchStores` construct fine under `vertexai: true` and fail at call time | No startup signal; a Vertex misconfiguration surfaces as a request error in production |
| R7 | `ai.interactions` and `ai.fileSearchStores` both hang off the standard client; streaming is real (`stream: true` → `Stream<InteractionSSEEvent>`) | SSE chat (Phase 3) is viable |

### Corrections to the plan as written
| # | Finding | Plan change |
| --- | --- | --- |
| R8 | **TTS is not reachable via `interactions`** (`400 invalid argument`). It works on `generateContent`, returning `audio/l16; rate=24000; channels=1` | Keep TTS on `generateContent`. Headerless 24kHz mono PCM confirmed, so `pcmToWav` (Phase 4) is still required |
| R9 | **`response_format` takes an inline JSON-Schema-shaped object, not an OpenAI-style `json_schema` wrapper.** Accepted `type` values: `integer, video, object, audio, image, array, boolean, string, text, number` | Use `{type:'object', properties:{…}}`. Still deletes `cleanJsonString` and the prompt-embedded schemas — pending confirmation in spike 0b |
| R10 | **Interaction responses have no `.text`** — keys are `id, status, usage, created, updated, service_tier, steps, object`; output lives in `steps` | Every current `response.text` call site must walk `steps`. Shape pending spike 0b |
| R11 | **Illustrations are returned as `image/jpeg`**, but `PaperList.tsx:244` and `BlogReader.tsx:364` hard-code `data:image/png;base64,` | Latent bug: renders today via byte-sniffing, but export would write JPEG bytes into `illustration.png`. Persist the real mime type alongside the blob |
| R12 | `importFile` takes a Files API name (`files/abc-123`), **not** a `gs://` URI — but `uploadToFileSearchStore` accepts `file: string \| Blob` | GCS → File Search needs no temp file and no Files API hop: stream GCS bytes into a Blob and upload directly. Simpler than Phase 2 as drafted |
| R13 | SDK type quality is weak as reported: `ResponseFormat_2` falls back to `{[k:string]: any}`; `UploadToFileSearchStoreParameters` is declared twice | Expect poor inference around Interactions; validate shapes at runtime |
| R14 | `.env` was **not** in `.gitignore`, though the README instructs creating one containing the API key | Fixed on branch `spike/phase-0-genai-v2`. Nothing was ever tracked |

### Resolved by `scripts/spike-phase0b.mjs`
| # | Question | Answer |
| --- | --- | --- |
| O1 | Does `file_search` combine with `url_context`? | **No.** Against a *real* store, `file_search` alone succeeded (C3) and `url_context` alone succeeded (spike 1, Q3b), but the pair returned `403 The caller does not have permission` (C4). Since both work individually with the same key and store, the rejection is the combination itself — reported as 403 rather than the clearer 400 used for Google Search (C5). **F2 holds in full: File Search composes with neither Google Search nor URL Context.** The staged pipeline and D5's chat toggle both stand |
| O2 | Correct `response_format` shape | **Inline JSON-Schema object works**: `{type:'object', properties:{…}, required:[…]}` (A1). Confirms R9. `cleanJsonString` and every prompt-embedded schema can be deleted in favour of enforced structure |
| O3 | Anatomy of `interaction.steps` | Two steps, typed **`thought`** and **`model_output`** (B1). Output extraction means locating the `model_output` step; the model also emits reasoning as a separate `thought` step |

Also confirmed: `uploadToFileSearchStore` accepts a `Blob` directly (C2), so GCS → File Search needs no temp file and no Files API hop (R12). Illustrations are `image/jpeg` (D1, reconfirming R11).

**Phase 0 is complete. No change to the plan's shape — F2 holding means the staged discover → ingest → ground pipeline is required, not optional.**

---

## Architecture

```
Browser (stateless view)
   │  fetch /api/*        ← no API key, no persisted data
   ▼
Cloud Run  ── Hono server, serves dist/ + /api/*
   ├─ Firestore ......... profiles, papers, chat metadata   (source of truth)
   ├─ Cloud Storage ..... PDFs, illustrations, audio        (artifact bytes)
   ├─ Secret Manager .... GEMINI_API_KEY
   └─ Gemini Developer API
        ├─ google_search  → discovery
        ├─ url_context    → paper ingestion
        ├─ file_search    → RAG over the corpus
        └─ File Search store (one per profile)
```

The browser becomes a pure view over server state. IndexedDB is dropped entirely — it was the previous plan's answer to a browser-local requirement that no longer exists.

---

## Decisions and trade-offs

### D1 — Firestore + GCS, browser holds nothing
Firestore stores `Profile`, `Paper` metadata, and chat messages; GCS holds the bytes. This removes the localStorage quota bug at the root rather than relocating it, and makes libraries follow the user across devices and browsers.

### D2 — Gemini Developer API in both environments (per F1)
One client, one code path, local and deployed. Key from `.env` locally, from Secret Manager on Cloud Run. **Fallback if org policy forbids API keys:** Vertex RAG Engine for retrieval and Vertex for generation — but that is a second retrieval stack with different semantics, so take it only under a hard constraint.

### D3 — Ingestion: `url_context` first, byte-fetch second
`url_context` reads PDFs directly (up to 34MB, ≤20 URLs/request, publicly accessible only). **This deletes the CORS proxy, the host allowlist, and the SSRF guard from the previous plan** — Google fetches the content, not our server. A large simplification and a meaningful reduction in attack surface.

We still fetch bytes server-side for the papers we want to *archive* in GCS and index in File Search, because File Search has no `gs://` import — the server downloads from GCS and calls `uploadToFileSearchStore`. Archival fetch is limited to the resolved open-access URL, so no user-controlled URL ever reaches our fetcher.

### D4 — One File Search store per profile
Scopes retrieval to the library the user is actually working in, keeps stores well under the 20GB latency guidance, and makes profile deletion a single store deletion. Store name recorded on the Firestore profile document.

### D5 — Chat routing under the F2 constraint
Since File Search and Google Search are mutually exclusive per call, route explicitly:
- Default: `file_search` over the profile's store — this is the app's actual value, and it replaces today's crude "concatenate every blog into the system instruction" approach with real semantic retrieval and citations.
- A visible UI toggle for live web search, which switches that turn to `google_search`.

**Chosen: an explicit toggle over an automatic classifier.** A classifier adds a model call, latency, and a failure mode that is invisible to the user; a toggle is honest about a constraint the API imposes. This is a small but real UX change to the existing bot.

### D6 — Local development: emulator by default, cloud-attached optional
| Concern | Local default | Local alt | GCP |
| --- | --- | --- | --- |
| Documents | Firestore emulator | real Firestore, dev project | Firestore |
| Blobs | filesystem `./.data/blobs` | real GCS dev bucket | GCS |
| Secrets | `.env` | `.env` | Secret Manager |
| Identity | stub dev user | stub dev user | IAP header |
| Gemini + File Search | **real API** | real API | real API |
| Hosting | Vite + Hono middleware | same | Cloud Run |

Blobs go behind a `BlobStore` interface with filesystem and GCS implementations; documents go behind a `Repository` interface, though both implementations are Firestore (emulator vs real), so drift is minimal.

**There is no File Search emulator.** Retrieval always calls the real API, even locally. Set `FILE_SEARCH_STORE_PREFIX=dev-` so local stores are distinguishable and cleanable.

### D7 — "Offline" is now dead, and that is a direct consequence
The earlier plan included running fully offline. With server-persisted state and cloud-only File Search, **the app cannot work without network.** Vendoring the CDN assets (Phase 6) is still worth doing — deterministic builds, no third-party runtime dependency, faster loads — but it no longer buys offline operation. Flagging because it is a capability you asked for earlier that this direction removes.

### D8 — Identity from IAP
Server-persisted state needs an owner. IAP supplies a verified identity header on Cloud Run; locally a stub user is injected. Firestore security follows the server's service account — the client never talks to Firestore directly, so all access is mediated by our API.

---

## Implementation phases

### Phase 0 — Baseline and SDK migration

1. `npm install`; create `.env` with `GEMINI_API_KEY`. Note `vite.config.ts:14-15` reads `GEMINI_API_KEY` and injects it as `process.env.API_KEY`; the README's `API_KEY=` alone does not work.
2. Fix README `npm start` → `npm run dev`. Process one paper to establish a baseline.
3. **Bump `@google/genai` `^1.39.0` → `^2.3.0`** (required for Interactions). Expect breaking changes.
4. Update the model IDs per F4.
5. **Verify before building on it:** that TTS and image generation are reachable through `interactions.create`, or whether they must stay on `generateContent`; and how structured JSON output is requested under Interactions (today the code sets `responseMimeType: 'application/json'` and embeds the schema in the prompt). The SDK's Interactions types are autogenerated from protobuf and type inference there is reportedly awkward — budget time for it.

### Phase 1 — Server + GCP-native persistence

**Add:** `hono`, `@hono/node-server`, `@google-cloud/firestore`, `@google-cloud/storage`

- [x] **`server/router.ts`** — framework-agnostic Hono app, mounted by Vite's `configureServer` in dev and by the Node server in production. One implementation, no drift.
- [x] **`server/repository.ts`** — Firestore access. Collections: `profiles/{id}`, `profiles/{id}/papers/{paperId}`, `profiles/{id}/messages/{messageId}`. Splitting papers and messages into subcollections avoids the current design's fatal flaw, where touching one field rewrites the entire library.
- [x] **`server/blobStore.ts`** — `BlobStore` interface; `GcsBlobStore` and `FsBlobStore`. Object layout `profiles/{profileId}/{paperId}/{kind}` with `kind ∈ pdf | illustration | audio`.
- [x] **`server/identity.ts`** — IAP header verification; stub user when `NODE_ENV !== 'production'`.
- [x] **`server/index.ts`** — production entry serving `dist/` plus the router on `PORT` (Cloud Run injects 8080).
- [x] **REST surface** — `/api/profiles` CRUD, `/api/profiles/:id/papers`, `/api/blobs/:key` (streamed, identity-checked), `/api/chat` (SSE).
- [x] **`vite.config.ts`** — mount the router; **delete the `define` block that inlines the API key into the client bundle.** This is the fix for the credential exposure.
- [x] **Migration** — a one-time `POST /api/import/localstorage` accepting the old `scholarMind_profiles_v1` payload, so existing browser libraries are not stranded. The client offers it once when it detects the key, then clears it after a verified round-trip.


**Phase 1 status: code complete, compiles clean (`tsc --noEmit` exit 0), server boots.**

Verified: `/api/healthz` responds identically through the Vite dev server and the Node entry (one router, no drift); blob keys reject path traversal (400); `npm run build` succeeds and the bundle no longer carries the API key — `process.env` collapses to `{}`, so `apiKey` resolves to `""`.

Deviations from the plan as written, for later phases to reconcile:
- Added `google-auth-library` — the plan says IAP *verification*, and trusting the plain `x-goog-authenticated-user-email` header would be forgeable by anything reaching the service directly. The signed JWT assertion is verified against Google's IAP keys, and the server refuses assertions when `IAP_AUDIENCE` is unset.
- `npm start` runs `tsx server/index.ts` rather than `node server/index.js`. Phase 7's Dockerfile assumes the latter, so Phase 7 must either keep `tsx` as a runtime dependency or add a server bundling step.
- The `Paper` fields listed under Phase 5 (`illustrationKey`, `audioKey`, `pdfKey`, `pdfStatus`, `fileSearchDocName`, plus `illustrationMime`/`audioMime` for R11) were added now, additively — the server needs them. The legacy `illustration`/`audioBase64` fields remain, marked `@deprecated`, and Phase 5 removes them.
- Added `illustrationMime`/`audioMime` beyond the plan, because R11 showed illustrations are JPEG while the app hard-codes PNG. The import path sniffs magic bytes rather than assuming.

Not verified locally: every Firestore-backed endpoint. The emulator component is not installed and Homebrew's gcloud blocks `gcloud components install`. Needs either `npx firebase-tools` with a `firebase.json`, or a dev GCP project via ADC.

### Phase 2 — Ingestion: URL Context → GCS → File Search

- [x] **`server/paperSource.ts`** — resolve a paper to an open-access URL: arXiv API → Crossref (DOI) → Unpaywall (`UNPAYWALL_EMAIL` required by their terms; treat the step as disabled when unset — do not hard-code a personal address) → `google_search` grounding as fallback.
- [x] **`server/ingest.ts`** — the pipeline:
  1. `url_context` on the resolved URL to extract structured metadata and full-text understanding.
  2. Fetch the PDF bytes and store to GCS via `BlobStore`.
  3. `fileSearchStores.uploadToFileSearchStore` with `customMetadata` (`paperId`, `title`, `year`, `authors`) so citations map back to library entries.
  4. Record `pdfKey`, `fileSearchDocName`, and `pdfStatus` on the Firestore paper document.
- [x] **Store lifecycle** — `fileSearchStores.create({ config: { displayName, embeddingModel: 'models/gemini-embedding-2' } })` on profile creation; delete on profile deletion.
- [x] **Failure handling** — any ingestion failure degrades to `google_search` generation rather than blocking. Preserve the existing contract where one bad paper cannot abort the run.
- **Verify:** whether a GCS V4 signed URL is accepted by `url_context` (docs require publicly accessible URLs). If yes, re-reading archived PDFs avoids a re-upload; if no, always read from the origin URL.

### Phase 3 — Generation and RAG chat

- [x] **`server/gemini.ts`** — all prompts move server-side, out of the browser. Preserve the existing per-function error contract exactly, since callers depend on it: scholar search re-throws; citations/TTS/illustration return empty; resource generation returns the "Generation Failed" placeholder.
- [x] **Generation** — `/api/papers/resources` grounds in `file_search` against the profile store when the paper is indexed, falling back to `google_search`. Never both (F2).
- [x] **Chat** — `/api/chat` uses `file_search` by default with the D5 toggle for web. Adopt `previous_interaction_id` so history is not resent each turn. Surface `file_citation` annotations in the UI — a genuine feature gain over the current bot, which cites nothing.
- [x] **Delete** the `knowledgeBase` string-concatenation block in the current `streamChatResponse`; File Search replaces it wholesale.

### Phase 4 — Export

**Add:** `fflate`

- [x] Server-side `/api/profiles/:id/export` streaming a ZIP: `blog.md` (YAML front matter), `slides.md`, `quiz.md`, `flashcards.csv`, `illustration.png`, `audio.wav`, `paper.pdf`, `metadata.json`, laid out `<profile-slug>/<paper-slug>/`.
- [x] **`pcmToWav`** — if TTS still returns headerless 24kHz Int16 PCM, wrap it in a 44-byte RIFF header **server-side at generation time**, so GCS holds playable WAV and both playback and export are byte pass-throughs. Verify the new TTS model's output container first.
- [x] Client-side export controls plus per-paper and per-profile controls in `PaperList`, `BlogReader`, `ProfileWorkspace`, and `Dashboard`.

### Phase 5 — Frontend rework

- [x] **`types.ts`** — drop `audioBase64` / `illustration`; add `pdfKey`, `illustrationKey`, `audioKey`, `pdfStatus`, `fileSearchDocName`.
- [x] **`App.tsx`** — remove localStorage entirely; profiles load from `/api/profiles`. Add loading and error states, which the current unguarded write path lacks.
- [x] **`services/api.ts`** — replaces `services/geminiService.ts` as a thin `fetch` client. Keep exported function signatures stable where possible so `ProfileWorkspace` and `BlogReader` call sites change minimally. Chat switches from the SDK iterator to an SSE reader, preserving the `onChunk` contract.
- [x] **Media** — `<img src="/api/blobs/{key}">` and audio from the same endpoint; `utils/audio.ts` collapses to `decodeAudioData` on fetched bytes.
- [x] **`ProfileWorkspace.tsx`** — `processPapers` becomes a thin trigger plus status polling (or SSE); the server owns the pipeline. Remove the fake `setTimeout` download step and the concurrency pool. Fix the pre-existing unawaited `Promise.all(workers)` by deleting the code that contains it.
- [x] **Delete `components/NotebookWorkspace.tsx`** and the `Notebook` / `ScholarProfile` types — imported by nothing, carries a stale duplicate `THEMES` palette.

### Phase 6 — Build assets (no longer "offline", per D7)

**Add:** `tailwindcss@^3.4`, `postcss`, `autoprefixer`, `@tailwindcss/typography`, `tailwindcss-animate`

Port the inline config at `index.html:11-45` to `tailwind.config.js` verbatim (fontFamily, the `scholarly` scale on `rgb(var(--primary-N) / <alpha-value>)`, `blob` keyframes); add `postcss.config.js` and `index.css` (directives, `:root` vars, scrollbar rules, `.glass-panel`, `@font-face`), imported from `index.tsx`. Vendor Inter and Merriweather into `public/fonts/`. Strip the CDN script, inline config, inline style, Google Fonts link, the vestigial importmap, and the dead `/index.css` link.

**`prose prose-slate` (`BlogReader.tsx:378`) and `animate-in fade-in zoom-in-95` (`BlogReader.tsx:288`) are currently inert** — the CDN build ships neither plugin. Enabling them will visibly change blog rendering and modal entry. An improvement, but a real visual change; screenshot before and after.

### Phase 7 — GCP deployment

- [x] **`Dockerfile`** — multi-stage `node:22-alpine` (matches local v22.21.0): build stage runs `npm ci && npm run build`; runtime stage carries production deps, `dist/`, `server/`, non-root user, `CMD node server/index.js`. Plus `.dockerignore`.
- [x] **`cloudbuild.yaml`** — build → Artifact Registry → `gcloud run deploy`; optional push trigger on `main`.
- [x] **Cloud Run** (flags set in cloudbuild.yaml) — `--min-instances 0`, `--memory 1Gi`, `--timeout 300s` (ingestion is slow), `--concurrency 80`, `--no-allow-unauthenticated`.
- [ ] **Service account** (provisioning, needs your project) — dedicated, not the default compute account: `roles/datastore.user`, `roles/storage.objectAdmin` on the bucket, `roles/secretmanager.secretAccessor`.
- [ ] **Secret Manager** (provisioning) — `GEMINI_API_KEY` via `--set-secrets`.
- [ ] **GCS bucket** (provisioning) — uniform bucket-level access, no public access, lifecycle rule for orphaned objects.
- [ ] **Firestore** (provisioning) — Native mode; composite indexes for the paper and message queries.
- [ ] **IAP** (provisioning) — enabled in front of the service; `roles/iap.httpsResourceAccessor` granted to intended users.
- **Verify in order:** SSE survives Cloud Run's proxy → File Search quota and tier sizing → Firestore index requirements under real query patterns.

---

## Tests

Add `vitest`. Scope to server logic and pure functions; the React tree is not worth harnessing here.

- `pcmToWav` — exact 44 header bytes (`RIFF`, size, `WAVEfmt `, format 1, channels, sample rate, byte rate, block align, bits, `data`).
- `BlobStore` — fs and GCS implementations against one shared contract suite (GCS mocked).
- `repository` — CRUD and cascade deletes against the Firestore emulator.
- `paperSource` — resolution fallback order with mocked `fetch`.
- `ingest` — GCS write plus File Search upload with the SDK mocked; degradation when resolution fails.
- `identity` — IAP header verification, including rejection of a forged header.
- Router — endpoint contracts, auth enforcement on `/api/blobs/:key`, and the preserved per-function error semantics.
- `slugify` — traversal, collisions, over-long titles, unicode.
- **A single live smoke test**, opt-in via env, asserting the F2 constraint still holds and the model IDs still resolve.

## Docs to update

- `README.md` — the app is no longer client-only; new stack, `GEMINI_API_KEY`, `npm run dev`, local emulator setup, GCP quickstart.
- `docs/architecture/README.md` — **substantially rewritten.** Its central claim, "operating as a serverless AI-wrapper application" with "no external database," is now false.
- `docs/deployment/README.md` — rewritten for Cloud Run; delete the "key is exposed to the browser" caveat, which this plan resolves.
- `docs/general/features.md` — citations in chat, the web-search toggle, export.
- `CLAUDE.md` — rewrite the storage, Gemini-layer, audio, and styling sections.

## Risks

| Risk | Mitigation |
| --- | --- |
| **F2 confirmed (O1)**: File Search composes with neither Google Search nor URL Context | Explicit UI toggle (D5) is now required, not provisional. Staged pipeline confirmed necessary |
| ~~`@google/genai` v1→v2 bump breaks the service layer~~ **Retired (R1)** — existing code typechecks clean against 2.21.0 | Migration to Interactions can proceed incrementally |
| ~~TTS/image unreachable via Interactions~~ **Resolved (R8)** — TTS stays on `generateContent`; image works on both | No further action |
| File Search unavailable on Vertex (F1, confirmed R5) blocks a key-free deploy | Accepted: key in Secret Manager, server-side only. Gating is runtime-only (R6), so misconfiguration fails in production, not at boot |
| `url_context` may reject GCS signed URLs | Verify in Phase 2; fall back to always reading the origin URL |
| Preview TTS model changes or is withdrawn | Pin the ID; keep `gemini-2.5-flash-preview-tts` as fallback |
| Firestore write amplification if the old whole-document pattern is copied | Papers and messages as subcollections (Phase 1), never one document per profile |
| File Search storage tier exceeded | 1GB free, 100MB/file; monitor and size the tier before bulk ingestion |
| Latency: ingestion is now several network hops | Server-owned pipeline with status streamed to the client; it was already slow and fake |
| Tailwind plugin activation changes the UI (Phase 6) | Screenshot key screens before and after |


---

## Implementation log (2026-09-05)

Branch `spike/phase-0-genai-v2`. `tsc --noEmit` clean throughout.

### Verified locally
Firestore emulator (`npm run emulator`, port 8085) plus the API mounted in Vite:
- Profile create / list / patch / delete, with delete returning 404 afterwards.
- Legacy localStorage import: inline base64 stripped into keyed blobs, mime recovered from magic bytes (`image/png` correctly identified), messages and papers landing in subcollections.
- Blob endpoint serves the right content type; unknown profile returns 404; path traversal (`/api/blobs/etc/passwd`) returns 400.
- Export ZIP well-formed: `blog.md`, `slides.md`, `quiz.md`, `flashcards.csv`, `metadata.json`, `illustration.png`, `audio.wav`, `README.md`. `file` confirms the WAV as *RIFF, WAVE audio, Microsoft PCM, 16 bit, mono 24000 Hz*.
- Identical `/api/healthz` through the Vite dev server and the Node entry — the one-router claim holds.
- Docker image builds and runs; in production mode unauthenticated requests are rejected with 401.
- Client bundle: **792KB → 401KB**, since the Gemini SDK no longer ships to the browser.

### Not verified
- Every Gemini-backed path (search, ingestion, generation, chat, TTS). They need a live `GEMINI_API_KEY`; the code is written against the shapes the Phase 0 spikes confirmed, but no live call has been made through the server.
- The `interaction.steps` extractor is defensive by necessity: the spike established the step *types* (`thought`, `model_output`) but not the inner field names, so `extractText` walks several plausible shapes. First live call may need adjustment.
- Chat streaming: `stream: true` returns `Stream<InteractionSSEEvent>`, but the per-event delta field name is unconfirmed, so there is a non-streamed fallback if no deltas are recognised.
- Visual verification of the UI. The Chrome extension was not connected, so the frontend was exercised over HTTP only.

### Environment note
Docker holds `127.0.0.1:3000` on this machine (another project), which shadows Vite's `*:3000` bind for localhost. Use `--port 5180` or stop that container.


---

## Live findings (2026-09-06, first run against a real API key)

### R15 — File Search and `response_format` JSON do not compose
Single-call generation with `file_search` grounding produced malformed JSON **every time**, failing at the first array:

```
"title": "Combating Overfitting",
"points":.",            <- should be  "points": [
```

The preceding text ended with a citation marker (`[3.5]`), and the corruption always lands where an array opens. The citation-insertion pass appears to rewrite the `[` that starts a JSON array. The interaction itself was well-formed — one `model_output`, one text item, correct length, not truncated — so this is model-side output corruption, not a parsing bug.

**Fix: two-stage generation.** Stage one gathers grounded notes as free prose with the tool attached; stage two structures those notes with `response_format` and **no tools**. Verified working: 5 slides, 5 quiz questions, 5 flashcards, zero parse failures.

This compounds F2. Grounding tools are mutually exclusive with each other *and* effectively incompatible with structured output, so any grounded structured generation needs two calls.

### Confirmed working live
- Scholar search: real affiliation, topics, and 5 correctly identified papers (~14s).
- `extractText` handles the live shape: `model_output.content[].text`. Step types seen: `file_search_call`, `file_search_result`, `thought`, `model_output`.
- Ingestion: resolved the AlexNet PDF from `papers.nips.cc`, stored 1.4MB (9 pages), indexed into File Search.
- Media: audio served as valid WAV (`RIFF, 16 bit, mono 24000 Hz`, 1.18MB); illustration is **JPEG 1376x768**, confirming R11 — the old hard-coded `data:image/png` was wrong.
- Chat: streaming deltas recognised, grounded in the library via File Search, answering correctly from the indexed PDF. The non-streamed fallback was not needed.
- Citations: `model_output` carries `annotations` with `document_uri`, `file_name`, and source excerpts — available for surfacing in the UI.

### Still not exercised
- URL Context ingestion path (the PDF resolved via arXiv/Crossref, so `url_context` was not the grounding route used).
- The web-search chat toggle (`useWebSearch: true`).
- Cloud Storage blob backend (filesystem was used locally).
- Any GCP deployment.
