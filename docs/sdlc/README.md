# SDLC

Four phases, each backed by a Claude Code skill. Plans live in `.claude/plans/` and persist across sessions.

```mermaid
flowchart LR
    P["/plan<br/><i>decide + verify</i>"] --> I["/implement<br/><i>build</i>"]
    I --> T["/test"]
    T --> R["/release"]
    I -.->|"assumption proved wrong"| P
    T -.->|"defect"| I

    style P fill:#f0f9ff,stroke:#0284c7
    style I fill:#ecfdf5,stroke:#059669
```

---

## Plan

Produces a numbered plan at `.claude/plans/<feature>.md` before any code exists: files to change, contract changes, tests to write, docs to update — and above all **the decisions and their trade-offs**.

**Verify assumptions here, not during implementation.** This rebuild was planned three times because research invalidated it twice:

```mermaid
flowchart TD
    V1["Plan v1<br/>Vertex AI for keyless auth"] -->|"File Search unavailable on Vertex"| V2
    V2["Plan v2<br/>CORS proxy + SSRF guard for PDFs"] -->|"url_context reads PDFs directly"| V3
    V3["Plan v3<br/>Developer API + url_context"] --> B["Built"]

    style V1 fill:#fef2f2,stroke:#dc2626
    style V2 fill:#fef2f2,stroke:#dc2626
    style V3 fill:#ecfdf5,stroke:#059669
```

The first cost a rewrite of the auth story. The second **deleted an entire component** — the proxy, its host allowlist, and its SSRF guard were never needed. Both were caught by reading current API documentation instead of relying on recall.

### Spike before committing to a design

Where a plan rests on unverified API behaviour, write a script that proves or disproves it. `scripts/spike-phase0*.mjs` retired one risk outright (the SDK major bump turned out to be non-breaking) and corrected three assumptions before any dependent code existed.

Cheap to run, and far cheaper than discovering it mid-implementation.

## Implement

Work the plan in order, confirm each step compiles, tick it off in the plan file so progress survives a session ending.

If the plan is wrong, say so rather than improvising around it, and record the deviation. This project accumulated several worth knowing later — for example adding `google-auth-library`, because "verify the IAP header" is not the same as trusting it.

**Some things are only knowable from a live run.** Two-stage generation exists because single-call generation failed against the real API in a way no amount of planning would have predicted.

## Test

```bash
npm test          # vitest run, no network
npm run test:watch
```

Vitest, scoped to logic that is pure or easily faked rather than the React tree.
The suite is deliberately narrow: it exists to catch drift in the places where a
regression is *silent*, not to chase coverage.

| Suite | Guards against |
| :--- | :--- |
| `export.test.ts` | a WAV header that downloads fine and refuses to play |
| `blobStore.test.ts` | path traversal through a URL-supplied blob key; one profile prefix-matching another |
| `gemini.test.ts` | an SDK upgrade moving the response text, which would surface as empty blog posts rather than an error |
| `sse.test.ts` | frames split across network chunks; a malformed frame tearing down the stream |
| `corpus.test.ts` | a de-dup key too loose (wrong paper's PDF) or too strict (de-dup never fires) |
| `env.test.ts` | a Cloud Run revision starting with authentication silently disabled; a wrong API key being accepted |
| `citations.test.ts` | BibTeX that will not parse, and citation styles drifting from their rules |

What is deliberately *not* covered: anything that needs the live Gemini API.
Those shapes change out from under the code, and a mock of them would assert
what was true when it was written. `scripts/spike-phase0*.mjs` cover that by
calling the real thing, and are run on SDK or model changes.

Two of these suites were written after the bug, not before it — the SSE and
startup-guard cases both came from failures found by hand.

## Release

```mermaid
flowchart LR
    A["typecheck"] --> B["build"]
    B --> C["docker:build"]
    C --> D{"SDK or model<br/>changed?"}
    D -->|yes| E["run spikes"]
    D -->|no| F["deploy"]
    E --> F
    F --> G["/api/healthz<br/>reports expected backends"]
```

Deployment is `gcloud builds submit --config cloudbuild.yaml`. See [deployment](../deployment/README.md).

---

## Write it down

Findings that cost real time belong in the docs, not just a commit message. The two grounding constraints in [architecture](../architecture/README.md#grounding-two-hard-constraints) each took a debugging session; both are now a paragraph that saves the next person that session.
