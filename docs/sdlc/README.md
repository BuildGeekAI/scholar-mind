# SDLC

This project uses four phases, each backed by a Claude Code skill: `/plan`, `/implement`, `/test`, `/release`. Plans live in `.claude/plans/` and persist across sessions, so work can be picked up where it stopped.

## Plan

Produces a numbered implementation plan at `.claude/plans/<feature>.md` before any code is written. A plan states files to change, data and API contract changes, tests to write, docs to update — and, most importantly, **the decisions and their trade-offs**.

Verify assumptions here rather than during implementation. This project's rebuild was planned three times because research invalidated it twice:

- Vertex AI was chosen for keyless auth — then File Search turned out to be unavailable on Vertex.
- Ingestion was designed around a CORS proxy with an SSRF guard — then URL Context turned out to read PDFs directly, deleting the component entirely.

Both were caught by reading current API documentation instead of relying on recall. A plan built on stale assumptions costs more than the research does.

### Spike before committing to a design

Where a plan depends on unverified API behaviour, write a spike script that proves or disproves it. `scripts/spike-phase0*.mjs` are the ones for this codebase; they retired one risk entirely (the SDK major-version bump turned out to be non-breaking) and corrected three assumptions before any dependent code existed.

## Implement

Work the plan in order. Confirm each step compiles before moving on, and tick it off in the plan file so progress survives a session ending.

If the plan turns out to be wrong, say so rather than improvising around it. Record deviations in the plan — this project accumulated several worth knowing about later, such as adding `google-auth-library` because "verify the IAP header" is not the same as trusting it.

Some things are only knowable from a live run. Two-stage generation exists because single-call generation failed against the real API in a way no amount of planning would have predicted.

## Test

Not yet configured. The plan specifies Vitest plus `fake-indexeddb`, scoped to logic that is pure or easily faked rather than the React tree:

- `pcmToWav` — assert the exact 44 header bytes
- `blobStore` — one contract suite across both implementations
- `repository` — CRUD and cascade deletes against the emulator
- `paperSource` — resolution fallback order with mocked `fetch`
- `identity` — including rejection of a forged assertion
- `export.slugify` — traversal, collisions, unicode

Until then, `npm run typecheck` and the verification spikes are the safety net.

## Release

Deployment is `gcloud builds submit --config cloudbuild.yaml`. See [deployment](../deployment/README.md).

Before releasing:

1. `npm run typecheck`
2. `npm run build`
3. `npm run docker:build` — the container is what ships
4. Run the spikes if the SDK or a model changed
5. Check `/api/healthz` after deploying reports the expected backends

## Writing it down

Findings that cost real time to discover belong in the docs, not just in a commit. The two grounding constraints in [architecture](../architecture/README.md#grounding-two-hard-constraints) each took a debugging session; both are now a paragraph that will save the next person that session.
