# 🎓 ScholarMind — AI Research Companion

ScholarMind turns academic papers into an interactive, multimedia knowledge base. Point it at a scholar or a paper title, and it retrieves the open-access PDF, indexes the full text for semantic retrieval, and generates a blog post, slide deck, quiz, flashcards, narrated audio, and cover art — then lets you ask questions grounded in what it read.

Built on Google Cloud: **Gemini** for generation and retrieval, **Firestore** for state, **Cloud Storage** for artifacts, and **Cloud Run** for hosting. It runs the same way locally.

---

## ✨ What it does

**Discovery.** Search a scholar by name or Google Scholar URL to pull their affiliation, topics, and most-cited papers. Or add individual papers by title.

**Ingestion.** For each paper, ScholarMind resolves an open-access PDF (arXiv → Crossref → Unpaywall → search), downloads it, and indexes it into a per-profile **File Search** store. Generation is then grounded in the paper's actual full text rather than search snippets.

**Generation.** A blog post, a 4–6 slide deck, a 5-question quiz with explanations, 5 flashcards, a narrated audio summary, and generated cover art.

**Chat.** Ask questions answered from your indexed library, with citations back to the source documents. A toggle switches a turn to live web search instead.

**Export.** Download any profile as a ZIP: `blog.md`, `slides.md`, `quiz.md`, `flashcards.csv`, `metadata.json`, the illustration, a playable `audio.wav`, and the source PDF.

---

## 🏗 Architecture

```
Browser (no API key, no persisted data)
   │  fetch /api/*
   ▼
Hono router ─── mounted by Vite in development AND Cloud Run in production
   ├─ Firestore ....... profiles / papers / messages
   ├─ Cloud Storage ... pdf, illustration, audio       (filesystem locally)
   ├─ Secret Manager .. GEMINI_API_KEY                 (.env locally)
   └─ Gemini Developer API
        google_search → discovery
        url_context   → reads paper URLs directly, including PDFs
        file_search   → retrieval over your library, with citations
```

The browser holds no credentials and no data. One router implementation serves both environments, so there is nothing that works locally but not deployed.

See [docs/architecture](docs/architecture/README.md) for the reasoning behind these choices.

---

## 🤖 Models

| Purpose | Model |
| :--- | :--- |
| Search, reasoning, generation, chat | `gemini-3.8-flash` |
| Cover illustrations | `gemini-3.1-flash-image` |
| Speech | `gemini-3.1-flash-tts-preview` |
| Retrieval embeddings | `gemini-embedding-2` |

Calls use the **Interactions API** (`ai.interactions.create`), except speech and image generation, which remain on `generateContent`.

---

## 🚀 Running locally

**Prerequisites:** Node 22+, a [Google AI Studio API key](https://aistudio.google.com/apikey), and Java 11+ (for the Firestore emulator).

```bash
npm install
cp .env.example .env       # then add your GEMINI_API_KEY
```

Minimum `.env`:

```env
GEMINI_API_KEY=AIzaSy...
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085
GOOGLE_CLOUD_PROJECT=scholarmind-local
FILE_SEARCH_STORE_PREFIX=dev-
```

Then, in two terminals:

```bash
npm run emulator     # Firestore emulator on :8085
npm run dev:local    # app on :3000
```

Check configuration at any time with `curl localhost:3000/api/healthz`:

```json
{"ok": true, "geminiKey": "configured", "firestore": "emulator", "blobs": "filesystem"}
```

> **Note:** there is no File Search emulator. Retrieval always calls the real API, even locally — hence `FILE_SEARCH_STORE_PREFIX`, which keeps local stores easy to identify and clean up.

Full setup, including running against a real GCP project instead of emulators, is in [docs/development](docs/development/README.md).

---

## ☁️ Deploying to GCP

```bash
gcloud builds submit --config cloudbuild.yaml
```

The service deploys private (`--no-allow-unauthenticated`) and expects IAP in front of it. Full provisioning — service account, bucket, Firestore, Secret Manager, IAP — is in [docs/deployment](docs/deployment/README.md).

---

## 📜 Scripts

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Vite dev server with the API mounted |
| `npm run dev:local` | Same, pointed at the Firestore emulator |
| `npm run emulator` | Firestore emulator |
| `npm run build` | Production client build |
| `npm start` | Production server (serves `dist/` plus the API) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run docker:build` | Build the container image |

---

## 📁 Layout

```
server/       API: router, Firestore repository, blob store, Gemini, ingestion, export
components/   React UI
services/     api.ts — the browser's only server interface
docs/         Architecture, deployment, development, features, SDLC
scripts/      API verification spikes
```

---

## 📄 License

MIT. Open source for educational and research purposes.
