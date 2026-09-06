# Architecture

ScholarMind is a React SPA served by a small Node API. The browser is a view: it holds no credentials and no persisted state. Everything durable lives in Firestore and Cloud Storage, and every model call happens server-side.

> This replaces an earlier design in which the browser called Gemini directly and stored everything — including base64 images and audio — in a single localStorage key. That approach leaked the API key into the client bundle and hit the ~5MB storage quota after a handful of papers.

## Shape

```
Browser
   │  fetch /api/*
   ▼
Hono router  ── mounted by Vite (dev) and @hono/node-server (prod)
   ├─ Firestore ....... profiles/{id}, /papers/{id}, /messages/{id}
   ├─ BlobStore ....... GCS in production, filesystem locally
   └─ Gemini Developer API
```

## Key decisions

### One router, two hosts
`server/router.ts` is a framework-agnostic Hono app. `vite.config.ts` mounts it through `configureServer`; `server/index.ts` mounts it under `@hono/node-server` and also serves `dist/`. There is no separate development API, so there is no drift between environments.

### Gemini runs server-side, behind named endpoints
The server owns prompts and model IDs; clients send parameters. This keeps the key out of the browser, and it means the deployed surface is a fixed set of operations rather than a general proxy to your billing account. A pass-through `generateContent` endpoint would let anyone who found the URL run arbitrary prompts on your quota.

Removing the SDK from the client also cut the bundle from 792KB to 401KB.

### The Developer API, not Vertex
Vertex would allow ADC and no API key at all, which is otherwise preferable. But **File Search is unavailable on Vertex** — the SDK's own types say so (`genai.d.ts`: *"This data type is not supported in Vertex AI"*), and so are the grounding-chunk fields that carry citations. Vertex's equivalent is RAG Engine, a different API with a different resource model.

Since retrieval is central here, the Developer API is used in every environment, with the key in Secret Manager. The gating is **runtime-only**: both `interactions` and `fileSearchStores` construct fine under `vertexai: true` and fail at call time, so a misconfiguration surfaces as a request error rather than a startup failure.

### Firestore subcollections, not one document per profile
`profiles/{id}` holds metadata; papers and messages are subcollections. The previous model kept every paper inside one profile object, so editing a title rewrote the entire library. Subcollections make writes proportional to what actually changed.

### Blobs are keys, never inline
`Paper` carries `illustrationKey`, `audioKey`, and `pdfKey`. Bytes never enter React state or a Firestore document. Keys are `profiles/{profileId}/{paperId}/{kind}`, and `/api/blobs/*` checks ownership against the embedded profile ID, so a key alone is not a capability.

`BlobStore` has GCS and filesystem implementations behind one interface, which is what lets local development run without a bucket.

## Grounding: two hard constraints

Both were found by testing the live API, and both shape the pipeline.

### 1. Grounding tools are mutually exclusive
File Search composes with neither Google Search nor URL Context:

```
400 'google_search' and 'file_search' cannot be combined in the same request.
```

So work is staged — `google_search` to discover, `url_context` to ingest, `file_search` to answer — and chat exposes an explicit toggle rather than guessing which the user wanted.

### 2. File Search corrupts structured JSON
Generating structured output *while* File Search is attached produces malformed JSON, reliably, at the first array:

```
"title": "Combating Overfitting",
"points":.",            <- should be  "points": [
```

The preceding text always ends in a citation marker like `[3.5]`. The citation-insertion pass rewrites the `[` that opens the array. The response is otherwise well-formed and complete, so this is model-side corruption, not a parsing fault.

**Generation therefore runs in two stages** (`server/gemini.ts`): stage one gathers grounded notes as free prose with the tool attached; stage two structures those notes with `response_format` and no tools. Any grounded structured generation needs two calls.

## Ingestion

`server/ingest.ts` per paper:

1. `server/paperSource.ts` resolves an open-access PDF — arXiv, then Crossref for a DOI, then Unpaywall, then search grounding. Deterministic sources are tried before the model.
2. The PDF is fetched, size-capped, and verified by magic bytes.
3. It is stored via `BlobStore` and indexed into the profile's File Search store. `uploadToFileSearchStore` accepts a `Blob`, so no temp file or Files API hop is needed.
4. Generation runs, then speech and illustration concurrently.

Every failure degrades rather than blocks: no PDF falls back to URL context, then to search grounding. One bad paper cannot abort a run.

## Audio

Gemini TTS returns headerless 24kHz mono Int16 PCM (`audio/l16`). The blob endpoint wraps it in a 44-byte RIFF header before serving, so the browser gets a playable WAV and the client needs no sample conversion. Export writes the same bytes straight out.

## Identity

`server/identity.ts` verifies the signed IAP JWT assertion against Google's public keys. The plain `x-goog-authenticated-user-email` header is deliberately not trusted on its own — anything able to reach the service directly could forge it. When `IAP_AUDIENCE` is unset the server refuses assertions rather than falling back. In development a stub user is injected.

Firestore rules deny all direct client access; every read and write is mediated by the API server's service account.
