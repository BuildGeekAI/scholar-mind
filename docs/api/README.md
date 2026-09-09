# API & MCP

ScholarMind is usable three ways, over one implementation. The browser, `curl`,
and an MCP client all hit the same Hono router — there is no separate
"integration API" that can drift from what the app actually does.

```mermaid
flowchart LR
    B["🌐 Browser<br/><i>session, no key</i>"] --> R
    C["⌨️ curl / scripts<br/><i>x-api-key</i>"] --> R
    M["🤖 MCP client<br/><i>mcp/server.mjs</i>"] --> R

    R["Hono router<br/><b>/api/*</b>"] --> S["Postgres · Blobs · Gemini"]

    style B fill:#fef3c7,stroke:#d97706
    style C fill:#f0f9ff,stroke:#0284c7
    style M fill:#f5f3ff,stroke:#7c3aed
```

---

## Authentication

Three ways in, resolved in this order: **API key → session cookie → IAP → dev user**.

### Per-user API keys

Mint one from a signed-in session; it is returned exactly once, because only a
hash is stored.

```bash
curl -X POST $SM/api/keys -H 'content-type: application/json' \
  -d '{"name":"laptop","scope":"read"}'
# {"key":"sm_3b140aeb7208_e17c40…","record":{…}}

curl -s $SM/api/profiles -H "x-api-key: sm_3b140aeb7208_e17c40…"
curl -s $SM/api/profiles -H "Authorization: Bearer sm_3b140aeb7208_e17c40…"
```

A key **acts as its owner** and inherits their sharing exactly — there is no
second permission model. A `scope` can only narrow it:

| Scope | May |
| --- | --- |
| `read` | `GET` anything the owner can see, plus `POST /chat` and `POST /tts` |
| `write` | everything the owner can do |

Neither scope may mint or revoke keys. Otherwise a leaked write key could create
successors that outlive it, and revoking the original would not revoke the access
it was used to create. **Key management requires a signed-in session.**

| Request | Result |
| :--- | :--- |
| Valid key | Authenticated as its owner, with its scope |
| **Wrong key** | **`401` — in every environment, including local development** |
| Revoked or expired key | `401`, indistinguishable from an unknown one |
| Read-only key attempting a write | `403` |
| No key at all | The session cookie, then IAP, then the dev user (local only) |

A wrong key is refused even locally on purpose: falling through to the dev user
would mean a misconfigured integration works on a laptop and fails only once
deployed.

> `SCHOLARMIND_API_KEY` still works as a deployment-wide bootstrap key, for
> existing MCP clients and scripts. It maps to **one** configured identity, so
> two people sharing it share an account. Prefer per-user keys.

### Browser sessions

Firebase Authentication issues an ID token; the server verifies it and exchanges
it for a session cookie once. Everything after that is an ordinary cookie
request — no `Authorization` header, no token refresh.

```
client → Firebase signInWithPassword → ID token
       → POST /api/auth/firebase { idToken }
       → sm_session cookie
```

An unverified address is refused, and `AUTH_ALLOWED_DOMAINS` decides which
domains may sign in at all.

`/api/healthz` needs no authentication.

---

## Endpoints

### Libraries

| | | |
| :--- | :--- | :--- |
| `GET` | `/api/profiles` | Every library |
| `POST` | `/api/profiles` | Create one — `{title, emoji}` |
| `GET` | `/api/profiles/:id` | Library, sources and chat history |
| `PATCH` | `/api/profiles/:id` | Rename — `{title}` |
| `DELETE` | `/api/profiles/:id` | Delete it, its store and its blobs |
| `GET` | `/api/discover?q=` | Find existing libraries. No model call |

```bash
# Create a library
curl -s $SM/api/profiles -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"title":"Transformers","emoji":"🤖"}'
# → {"id":"a1b2…","title":"Transformers","fileSearchStoreName":"fileSearchStores/…"}

# Is there already one for this scholar? Answered from stored identities.
curl -s "$SM/api/discover?q=Geoffrey+Hinton" -H "x-api-key: $KEY"
# → {"query":"Geoffrey Hinton","matches":[{"id":"…","title":"Geoffrey Hinton","exact":true,…}]}
```

### Adding things

| | | |
| :--- | :--- | :--- |
| `POST` | `/api/profiles/:id/search` | Build from a scholar — `{query, allowDuplicate?}` |
| `POST` | `/api/profiles/:id/papers/find` | Add one paper by title — `{query}` |
| `POST` | `/api/profiles/:id/sources` | Add any link — `{url}` |
| `POST` | `/api/profiles/:id/sources/upload` | Upload a file — multipart `file` |
| `GET` | `/api/profiles/:id/papers` | List everything in the library |
| `DELETE` | `/api/profiles/:id/papers/:paperId` | Remove one, and its indexed document |

```bash
# A scholar's library. 409 with {duplicate} if one already exists.
curl -s $SM/api/profiles/$ID/search -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"query":"https://scholar.google.com/citations?user=JicYPdAAAAAJ"}'

# Any link — the kind is detected from the URL
curl -s $SM/api/profiles/$ID/sources -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=aircAruvnKk"}'
# → {"kind":"youtube","title":"But what is a neural network?","extractedText":"…"}

# Upload a recording, a video or a document (≤50MB)
curl -s $SM/api/profiles/$ID/sources/upload -H "x-api-key: $KEY" \
  -F "file=@lecture.wav;type=audio/wav"
# → {"kind":"audio","title":"…","extractedText":"<transcript>"}
```

Refusals are explicit: `415` for an unsupported type, `413` over 50MB, `409` for
a link the library already has.

### Processing

`POST /api/profiles/:id/process` — `{paperIds: [...], mode}` — **enqueues** and
returns `202 {runId}`. The work outlives the request: crawling a scholar and
indexing their papers takes minutes, so a dropped connection, a reload or a
closed tab no longer cancels anything.

The two halves are separate because they cost differently.

| `mode` | Does | Roughly |
| :--- | :--- | :--- |
| `index` | Fetch and embed, so chat can cite it | 5–10s per source |
| `artifacts` | Blog, slides, quiz, flashcards, audio, art | ~1min per source |
| `both` | Index, generate, then re-index against the write-up | The sum |

```bash
curl -s $SM/api/profiles/$ID/process -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"paperIds":["source-123"],"mode":"index"}'
# {"runId":"4a3413ca-…","enqueued":1,"skipped":0}
```

Asking twice is idempotent. A second identical request returns the run already
doing the work, with `enqueued: 0` and `alreadyRunning: true` — not a duplicate.

**Nothing happens without a worker running.** Locally that is `npm run worker`.

### Runs and status

| Method | Path | Does |
| :--- | :--- | :--- |
| `GET` | `/api/runs/:runId` | One run, with its job counts |
| `GET` | `/api/profiles/:id/status` | Per-source download / enrich / index, plus the active run |

Both support `ETag` / `If-None-Match`, so a two-second poll costs a `304`.

```bash
curl -s $SM/api/profiles/$ID/status -H "x-api-key: $KEY"
```
```json
{
  "run": {"id":"4a3413ca-…","kind":"crawl","status":"running"},
  "progress": {"queued":1,"running":4,"succeeded":1,"failed":0,"total":6},
  "papers": [
    {"id":"source-123","title":"…","stage":"fetching",
     "download":"running","enrich":"pending","index":"pending"}
  ]
}
```

A run reaching `cancelled` with `detail.duplicate` means the crawl found the
scholar already has a library — the check that needs the resolved name can only
run after the model call, so it reports here rather than as a `409`. Nothing was
written.

`pdfReused: true` on a source means another library had already fetched that
paper, so this run skipped resolution and download entirely.

### Sharing

Visibility is the broad control; grants are additive on top and name individuals.
A grant can only widen access, never narrow it.

| Method | Path | Does |
| :--- | :--- | :--- |
| `GET` | `/api/profiles/:id/sharing` | Visibility, your role, current grants, and who you could share with |
| `POST` | `/api/profiles/:id/sharing` | Share — `{email, role}` where role is `viewer` or `editor` |
| `DELETE` | `/api/profiles/:id/sharing?principalType=user&principalId=` | Revoke |
| `PATCH` | `/api/profiles/:id` | Change visibility — `{visibility}`: `private`, `team` or `org` |

Only the **owner** may change sharing. An editor can add papers; letting them also
add people would make sharing transitive by accident. Sharing is with people who
already exist — there is no invitation flow, and a grant to an address nobody has
signed in as would match nothing.

### Search

One query across every library you can reach, however many that is.

| Method | Path | Does |
| :--- | :--- | :--- |
| `GET` | `/api/search?q=&scope=&profileId=&limit=` | Hybrid keyword + semantic retrieval |

`scope` is `me`, `team`, `org` (default) or `profile`. The authorization
predicate is a clause in the same query as the retrieval, so results can never
include a library you cannot see.

Retrieval treats the query as a **question, not a search box**: the terms are
OR-ed and ranked, so a passage matching more of the question wins and one
missing word does not eliminate it. Asking for something genuinely unrelated
still returns nothing, which is what lets an advisor abstain honestly.

> Semantic retrieval additionally requires `0004_embeddings.sql`. Without it
> this is keyword-only — good enough for questions phrased in the source's own
> vocabulary, weaker for paraphrases.

### Advisors

An advisor is a library given a voice. Consulting one reads its author's
published work through that voice — it is not a simulation of the person.

| Method | Path | Does |
| :--- | :--- | :--- |
| `GET` | `/api/advisors` | Advisors you can reach, with indexed counts |
| `PATCH` | `/api/profiles/:id/advisor` | `{enabled, name, title, brief}` |
| `POST` | `/api/consult` | Ask a panel — `{question, advisorIds, synthesise?}` |
| `GET` | `/api/consultations` | Past consultations |
| `GET` | `/api/consultations/:id` | One, with its answers and sources |

`/api/consult` streams one `advisor` event per answer, so the first arrives well
before the last, then an optional `synthesis` and a `done`.

Answers cite the passages **actually passed to the model** — a fact about our own
retrieval, not something the model reported. An advisor whose indexed work does
not address the question says so and is never asked at all.

### Crawlers

A crawler is the standing definition of where a library's content comes from; a
run is one execution of it.

| Method | Path | Does |
| :--- | :--- | :--- |
| `GET` | `/api/crawlers?profileId=` | List |
| `POST` | `/api/crawlers` | Create — `{profileId, target, intervalSeconds?}` |
| `PATCH` | `/api/crawlers/:id` | `{target, intervalSeconds, enabled}` |
| `DELETE` | `/api/crawlers/:id` | Remove |
| `POST` | `/api/crawlers/:id/run` | Run now — returns `202 {runId}` |

`intervalSeconds` omitted means manual only.

### API keys

| Method | Path | Does |
| :--- | :--- | :--- |
| `GET` | `/api/keys` | Your live keys — never the key itself |
| `POST` | `/api/keys` | Mint — `{name, scope, expiresInDays?}`. **Returns the key once** |
| `DELETE` | `/api/keys/:keyId` | Revoke, immediately |

### Asking

`POST /api/chat` — `{profileId?, message, useWebSearch?}` — streams SSE.

What it grounds in depends on what you pass, and the three cases use different
machinery:

| `profileId` | `useWebSearch` | Grounds in | How |
| :--- | :--- | :--- | :--- |
| set | false | that library's **full paper text** | File Search |
| null | false | **every library you can reach** | Postgres retrieval, passages inline |
| any | true | the live web | `google_search` |

The cross-library case has no five-store ceiling — that limit belonged to File
Search — and its citations are the passages actually placed in the prompt rather
than what the model reported afterwards.

The `done` event reports `searchedLibraries`: which libraries *contributed*, not
which were asked.



`POST /api/chat` — `{profileId, message, useWebSearch}` — streams SSE.

**Omit `profileId` to ask across every library.** With one, the answer is scoped
to that library alone.

```bash
# Scoped to one library
curl -sN $SM/api/chat -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"profileId":"'$ID'","message":"What problem does this solve?"}'

# Across everything
curl -sN $SM/api/chat -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"message":"What do my libraries say about attention?"}'
```
```
event: delta
data: {"text":"Multi-head attention "}

event: citations
data: {"citations":[{"fileName":"Attention Is All You Need","snippet":"…"}]}

event: done
data: {"grounded":true,"searchedLibraries":["Transformers","Neural nets"],"skippedLibraries":2}
```

> `skippedLibraries` is not cosmetic. **File Search accepts at most five stores
> per call** — six returns `400`. A cross-library question searches the five most
> recently touched, and says which. See [architecture](../architecture/README.md).

### Citations

| | | |
| :--- | :--- | :--- |
| `GET` | `/api/profiles/:id/papers/:paperId/citation` | Every style for one source |
| `GET` | `/api/profiles/:id/citations?style=` | The whole bibliography |
| `GET` | `/api/profiles/:id/citations?style=&download=1` | As a `.bib` / `.ris` / `.txt` file |

Styles: `bibtex`, `apa`, `mla`, `chicago`, `harvard`, `ris`.

```bash
curl -s "$SM/api/profiles/$ID/citations?style=bibtex" -H "x-api-key: $KEY" | jq -r .text
curl -s "$SM/api/profiles/$ID/citations?style=ris&download=1" -H "x-api-key: $KEY" -o library.ris
```

Bibliographic detail comes from Crossref or not at all — never from the model.
`hasBibliographicData: false` means no Crossref record matched, so the citation
holds only what the library knows. Nothing is invented to fill the gaps.

### Media and export

| | | |
| :--- | :--- | :--- |
| `GET` | `/api/blobs/*` | A stored artifact. Ownership is checked against the key's profile |
| `GET` | `/api/profiles/:id/export` | The whole library as a ZIP |
| `POST` | `/api/tts` | Speech — `{text, voice}` → WAV |
| `GET` | `/api/healthz` | Which backends are live |

---

## MCP

```mermaid
sequenceDiagram
    participant A as Agent
    participant M as mcp/server.mjs
    participant S as ScholarMind API

    A->>M: find_library("Hinton")
    M->>S: GET /api/discover
    S-->>M: no matches
    A->>M: build_scholar_library("Geoffrey Hinton")
    M->>S: POST /profiles → POST /search
    S-->>M: 7 papers
    A->>M: index_sources(library_id)
    M->>S: POST /process (SSE)
    Note over M: collects frames,<br/>returns the outcome
    M-->>A: {requested: 7, indexed: 7, errors: []}
    A->>M: ask("What is dropout for?")
    M-->>A: answer + citations
```

### Register it

```bash
claude mcp add scholarmind -- node /absolute/path/to/scholar-mind/mcp/server.mjs
```

Or by hand, in an MCP client config:

```json
{
  "mcpServers": {
    "scholarmind": {
      "command": "node",
      "args": ["/absolute/path/to/scholar-mind/mcp/server.mjs"],
      "env": {
        "SCHOLARMIND_URL": "http://localhost:8080",
        "SCHOLARMIND_API_KEY": "your-key-here"
      }
    }
  }
}
```

The ScholarMind server must already be running — the MCP server is a client of
it, not a replacement for it.

### Tools

| Tool | Does |
| :--- | :--- |
| `list_libraries` | Every library, with source and indexed counts |
| `find_library` | Search by scholar, title or topic. No model call, no cost |
| `create_library` | An empty library |
| `build_scholar_library` | Create *and* populate from a scholar |
| `add_source` | Any link — page, Wikipedia, YouTube, PDF |
| `add_paper` | A paper by title |
| `list_sources` | Everything in a library, and whether it is indexed |
| `index_sources` | Embed for search. Defaults to everything unindexed |
| `generate_study_material` | Blog, slides, quiz, flashcards, audio, art |
| `read_study_material` | Read back what was generated |
| `ask` | Scoped to a library, or across all of them |
| `get_citation` | One source, every style |
| `export_bibliography` | The whole library in one style |

The intended order is **find before you build**: `find_library` is answered from
stored identities with no model call, so an agent that checks first never pays
to rediscover a library that already exists.

`index_sources` before `ask`, and `generate_study_material` only when someone
actually wants to read — it is roughly ten times slower than indexing and
produces nothing that chat needs.

### Worked example

```
find_library("Geoffrey Hinton")        → {"matches": []}
build_scholar_library("Geoffrey Hinton") → {"profileId": "a1b2", "papers": [7 papers]}
index_sources("a1b2")                  → {"requested": 7, "indexed": 7, "errors": []}
ask("What is dropout for?", "a1b2")    → {"answer": "…", "grounded": true,
                                          "citations": ["Improving neural networks by…"]}
get_citation("a1b2", "paper-0-…")      → {"citations": {"bibtex": "@article{…}", …}}
```

### Errors

Failures return as tool results with `isError: true` and the reason attached,
rather than as protocol exceptions — an agent can read `404 Not found` and pick
a different library, but cannot do anything with a transport error.

