# Plan: Advisors — consult a scholar's body of work as a persona

**Status:** IMPLEMENT complete for Phases 1–5; Phase 0 blocked (no API key in this checkout); Phase 6 is `/test`
**Phase:** IMPLEMENT
**Builds on:** `.claude/plans/multitenant-postgres-pipeline.md` (merged: tenancy, ACLs, the queue, and the Postgres reverse index this feature depends on)

## Requirement

Let a user "hire" an advisor — Albert Einstein, say — and ask questions that are answered from that person's actual published work, with several advisors consultable at once and an advisor shareable across an org.

---

## What already exists

More than it sounds. An advisor is very nearly a profile that has been given a voice.

| Piece | Status |
| --- | --- |
| Build a library from a scholar's name or Scholar URL | Done — `POST /profiles/:id/search`, now queued |
| Resolve, download and index their papers | Done — `crawl.profile` → `paper.index` |
| Ask questions grounded in that library | Done — `POST /chat` with File Search |
| Share a library across an org, or with named people | Done — `visibility` + `resource_grants` |
| Build the same scholar twice without re-downloading | Done — `server/corpus.ts`, measured 10.6s → 5.2s |
| Retrieve across many libraries, ACL-scoped | Done — `server/search.ts` |
| Citations that cannot be hallucinated | Done — metadata and Crossref only, never the model |

So the feature is a thin layer over the pipeline, not a parallel one. What is missing is a voice, a way to ask more than one advisor at once, and a place in the UI to meet them.

---

## The constraint that shapes the design

`POST /chat` grounds with File Search, and CLAUDE.md records three limits verified against the live API: **five stores per call is hard** (six returns `400`), File Search **composes with neither Google Search nor URL Context**, and retrieval **cannot be scoped below a store**.

A panel of advisors is precisely a query across N libraries. At six advisors, File Search stops working — not degrades, *stops*. That makes the current chat path unusable for this feature at any interesting size.

**The advisor path therefore retrieves from Postgres and passes the passages to the model as text, with no grounding tool attached.** Three things fall out, and they are the reason this is the right shape rather than a workaround:

1. **No cap.** Twenty advisors is the same query as two.
2. **Citations become exact.** We know which chunks we passed in, so a citation is a fact about our own retrieval rather than something the model reported. That is strictly stronger than the current annotation-scraping, and it satisfies the repo's standing rule that citations never come from the model.
3. **It composes.** With no tool attached, the F2 constraint does not apply — an advisor turn *can* also use Google Search, which a File Search turn never could.

---

## Decisions

### D1 — An advisor is a profile with a persona, not a new kind of object
Adding `advisor_*` columns to `profiles` inherits, at no cost: ACLs and sharing, the crawler and queue, corpus de-duplication, the index, export, and the existing chat. A separate `advisors` table would need every one of those rebuilt or joined through.

The cost is that "profile" now means two things — a personal library and a published advisor. Acceptable: the distinction is one boolean, and they genuinely are the same object with different presentation.

### D2 — The persona shapes voice and stance, never facts
This is the decision the whole feature lives or dies on. A persona prompt that says "you are Einstein" invites the model to answer *as* Einstein on subjects Einstein never addressed, and it will, fluently.

The system prompt therefore states the sources are the authority, instructs the model to say plainly when the retrieved passages do not cover the question, and every claim is answerable back to a chunk we selected. An advisor with nothing relevant indexed should say so, not improvise.

**Presentation follows:** the UI says *"grounded in Albert Einstein's published work"*, never *"I am Albert Einstein"*, and answers carry their sources. This is an honest research tool, not an impersonation.

### D3 — Living people are permitted but labelled identically
The mechanism does not change: it is still retrieval over what someone actually published. The risk is that a persona of a living person reads as *their* endorsement of an answer they never gave. The same labelling and the same citations handle it, and no advisor may be created for a private individual — the corpus already holds only public open-access content.

### D4 — A consultation names its advisors; there are no saved panels yet
"Hiring" is selecting advisors for a question. No new state, no roster table. Saved panels are a natural follow-on and deliberately out of scope — the interesting question is whether multi-advisor answers are useful at all, and that is answerable without persistence.

### D5 — Retrieval quality is now load-bearing, and it is currently keyword-only
`0004_embeddings.sql` is still unapplied because `gemini-embedding-2`'s output dimension has never been measured. Everything so far worked keyword-only. This does not: *"what would Einstein say about determinism"* shares few words with the papers that answer it. Semantic retrieval is the difference between a useful advisor and one that misses.

**This is a prerequisite, not a nice-to-have.** `GEMINI_API_KEY=... npm run spike:postgres`, read check G2, then `EMBEDDING_DIM=<n> npm run db:migrate`.

### D6 — Fan out per advisor, then optionally synthesise
Each advisor gets their own retrieval and their own model call, because merging their passages into one prompt produces a single averaged voice — which is the opposite of the point. A final synthesis pass over the individual answers is optional per request, off by default: it costs a round trip and is only worth it when advisors disagree.

Concurrency is capped at 3, matching the pipeline's existing restraint around API rate limits.

### D7 — The existing single-profile chat gains the persona for free
When a profile has an advisor persona, `POST /chat` uses it. Nothing else about that endpoint changes; it keeps File Search, because for one library the store cap is irrelevant and its annotations are already wired up.

---

## Data model

```sql
-- 0007_advisors.sql
ALTER TABLE profiles
  ADD COLUMN advisor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN advisor_name    text,      -- "Albert Einstein"
  ADD COLUMN advisor_title   text,      -- "Theoretical physicist, 1879–1955"
  ADD COLUMN advisor_brief   text,      -- stance and voice, not facts
  ADD COLUMN advisor_avatar_key text;   -- blob store, like illustrations

CREATE INDEX profiles_advisors ON profiles (advisor_enabled) WHERE advisor_enabled;

-- One row per consultation, so a panel answer can be reopened and cited later.
CREATE TABLE consultations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question    text NOT NULL,
  synthesis   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consultation_answers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE CASCADE,
  profile_id      text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  advisor_name    text NOT NULL,
  answer          text NOT NULL,
  -- The chunks actually passed to the model. Exact, not model-reported.
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ordinal         integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

`consultations` carries the tenancy triple and is reached through the standard predicate; each answer's advisor is re-checked for visibility at read time, so revoking a grant hides the advisor's contribution from a stored consultation too.

---

## Implementation

### Phase 0 — Prerequisite (blocking, per D5)
- [ ] Measure the embedding dimension and apply `0004_embeddings.sql`. Without it, retrieval is keyword-only and the feature will read as broken rather than limited.

### [x] Phase 1 — The advisor as a first-class thing
- `server/db/migrations/0007_advisors.sql` — as above.
- `server/repository.ts` — carry the new columns through `ProfileRecord`, `toProfile` and `UPDATABLE`.
- `server/router.ts`:
  - `GET /api/advisors` — every advisor-enabled profile the caller can see, with an indexed-paper count so an empty advisor is visibly empty.
  - `PATCH /api/profiles/:id/advisor` — enable, name, title, brief. `edit` access.
  - Optional avatar via the existing `generateIllustration` and blob store.
- `services/api.ts` — `listAdvisors`, `updateAdvisor`.

### [x] Phase 2 — `server/advisor.ts`, the retrieval-then-prompt path
The core of the feature, and the only genuinely new logic.

- `retrieveFor(ctx, profileId, question, k)` — `search()` scoped to one profile, returning chunks with their paper and profile.
- `systemPrompt(advisor)` — persona, plus the D2 guardrails stated explicitly: the passages are the authority; say so when they do not cover the question; do not answer beyond them.
- `askAdvisor(ctx, profile, question)` — retrieve, build the prompt, one `ai.interactions.create` with **no tools**, return `{ answer, citations }` where the citations are the chunks passed in.
- Error contract, matching the repo's convention: one advisor failing returns a placeholder for that advisor and never aborts the panel.

### [x] Phase 3 — Single-advisor chat gains the voice (D7)
- `POST /chat` uses `systemPrompt(profile)` when the profile is advisor-enabled, in place of the hardcoded "expert research assistant". Everything else about the endpoint is untouched.

### [x] Phase 4 — The panel
- `POST /api/consult` — `{ question, advisorIds[], synthesise? }`.
  - Each id resolved through `viewable`; unreachable ids are dropped and reported, not silently ignored.
  - Fan out at concurrency 3, stream each advisor's answer over SSE as it lands so the first arrives in seconds rather than after the slowest.
  - Optional synthesis turn over the collected answers.
  - Persist to `consultations` / `consultation_answers`.
- `GET /api/consultations`, `GET /api/consultations/:id`.
- SSE events: `advisor` (one per answer), `synthesis`, `done`, `error` — the same frame vocabulary the client parser already handles.

### [x] Phase 5 — UI
- `components/AdvisorGallery.tsx` — the advisors visible to you, each with name, title, avatar, indexed count, and who published it. This is the "hire" surface: select one or several.
- `components/Consultation.tsx` — the question box, answers streaming in per advisor, each with its sources, and the optional synthesis.
- `components/ProfileWorkspace.tsx` — a panel to turn a library into an advisor and write its brief.
- Labelling per D2, in the component and not left to the prompt.

### Phase 6 — Tests
Pure, no network, matching the existing suite:
- `systemPrompt` — includes the persona, and always includes the "say when the sources do not cover it" instruction. That instruction disappearing is the failure mode that matters and is invisible at a glance.
- Citation assembly — every returned citation corresponds to a chunk that was actually passed to the model, and none is invented.
- Advisor selection — unreachable ids dropped and reported; empty selection rejected.
- Fan-out — one failure yields a placeholder and the other answers survive.

Integration (`TEST_DATABASE_URL`):
- An advisor shared org-wide is consultable by another member; a private one is not.
- Revoking a grant removes that advisor's answers from a stored consultation.
- A consultation across more than five advisors succeeds — the case File Search cannot do, and the reason this path exists.

### Phase 7 — Docs
`docs/general/features.md` (what an advisor is and what it is not), `docs/api/README.md` (the new endpoints), `CLAUDE.md` (the advisor path retrieves from Postgres and attaches no tool — worth stating next to the File Search constraints so the next person understands why there are two paths).

---

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **The model answers beyond its sources**, fluently and wrongly. The central risk. | D2's prompt guardrails, exact citations, and a test that pins the instruction. Worth a manual pass asking an advisor something outside their work and checking it declines. |
| R2 | **Keyword-only retrieval makes advisors look stupid.** | Phase 0 is blocking, not advisory. |
| R3 | **A persona reads as impersonation**, particularly for a living person. | Labelled as "grounded in published work" in the component; citations always shown. |
| R4 | **Panel latency** — N advisors, each a retrieval plus a model call. | Concurrency 3 and per-advisor SSE, so the first answer arrives while the rest run. |
| R5 | **Cost scales with panel size**, and a ten-advisor panel is ten calls plus synthesis. | Cap panel size (start at 5), and make synthesis opt-in. |
| R6 | **An advisor with an empty library** answers confidently from nothing. | `GET /advisors` reports the indexed count; refuse a consultation with an advisor that has none. |

---

## Open questions

1. **Should an advisor be publishable beyond the org** — a shared public roster everyone can consult? The ACL model supports it as a fourth visibility, but that reopens the "public" question deferred in the previous plan.
2. **Does synthesis need its own persona** ("a chair summarising the panel"), or is a neutral summary right?
3. **Should a consultation be a queued job** rather than a streamed request? At five advisors streaming is fine; at fifty it is not. Deferred until panel size is a real problem.


---

## Implementation log

### Phase 0 — still outstanding, and still blocking for *quality*
`EMBEDDING_DIM` is unmeasured (no `GEMINI_API_KEY` in this checkout), so retrieval is keyword-only.
Everything below is built and works; advisors will simply miss questions phrased unlike the source
text. One command with a key: `npm run spike:postgres`, read check G2, then
`EMBEDDING_DIM=<n> npm run db:migrate`.

### What was built

| Phase | Result |
| --- | --- |
| 1 | `0007_advisors.sql`; `advisor_*` columns on `profiles`; `consultations` + `consultation_answers`; `listAdvisors` counting **indexed documents**, not papers — an unindexed paper cannot be retrieved, so counting papers would promise knowledge the advisor lacks |
| 2 | `server/advisor.ts` — retrieval-then-prompt, no grounding tool attached |
| 3 | `POST /chat` uses `systemPrompt(profile)` for an advisor profile and is otherwise untouched |
| 4 | `POST /consult` streaming per advisor at concurrency 3; `GET /consultations`, `GET /consultations/:id` |
| 5 | `AdvisorGallery`, `Consultation`, `AdvisorSettings`; entry point on the dashboard |

### The guardrail that actually holds

D2 said the persona must never supply facts. A prompt instruction is advice; the model may ignore
it. So **an advisor with no relevant passages is not asked at all** — `askAdvisor` returns
"Nothing in X's indexed work addresses this" without a model call. An absent call is a guarantee in
a way an instruction never is.

Verified live: asking the Einstein advisor about the luminiferous ether retrieved the right passage;
asking it for a sourdough recipe returned the abstention with zero citations and no model call.

### Verified live

| Case | Result |
| --- | --- |
| `PATCH /profiles/:id/advisor` | persona saved, profile becomes an advisor |
| `GET /advisors` | lists it with its indexed count and whether it is yours |
| Consult, question covered by the work | correct passages retrieved and cited |
| Consult, question not covered | abstains with no model call and no citations |
| Empty advisor list / empty question / unknown id | 400, 400, 404 |
| Consultation persisted and re-read | question, answers and citations intact |
| **Advisor made private after the fact** | stored answer reads "This advisor is no longer shared with you" — visibility is re-checked at read time, so a saved consultation is not a back door |

### Deviations

**`MAX_PANEL` truncates rather than rejecting.** A request naming more than five advisors takes the
first five and reports `unavailable`, instead of erroring. Consistent with how the chat endpoint
already handles the File Search store cap: tell the caller what was left out rather than refuse.

**No avatar generation.** The plan mentioned reusing `generateIllustration` for a portrait. Left
out — it is decoration, it costs an image call per advisor, and a generated likeness of a real
person cuts against D2's whole point that this is published work, not a simulation of a person.
The column exists if you want it.

**`GET /consultations` returns no answers.** The list is a list; answers load on open. Returning
every answer inline would mean running the visibility re-check across every consultation on every
list call.

### Still to do

- Phase 6 (tests) — `/test` owns it. `systemPrompt`, `pooled` and citation assembly are pure and
  written to be testable without a database.
- Phase 7 (docs) — `/release`.
- Open questions 1–3 from the plan remain open.
