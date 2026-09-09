-- 0007 — advisors.
--
-- An advisor is a profile that has been given a voice: the same library, the
-- same crawler, the same index, the same sharing — plus a persona and a place
-- in a gallery. Modelled as columns rather than its own table so it inherits
-- all of that instead of needing it rebuilt.

ALTER TABLE profiles
  ADD COLUMN advisor_enabled    boolean NOT NULL DEFAULT false,
  -- "Albert Einstein". Distinct from scholar_name, which is whatever the search
  -- resolved to, and from title, which is what the owner called the library.
  ADD COLUMN advisor_name       text,
  -- "Theoretical physicist, 1879–1955".
  ADD COLUMN advisor_title      text,
  -- Voice and stance only. Never facts: facts come from the retrieved passages,
  -- and a brief that asserts them invites the model to answer beyond its sources.
  ADD COLUMN advisor_brief      text,
  ADD COLUMN advisor_avatar_key text;

CREATE INDEX profiles_advisors ON profiles (advisor_enabled) WHERE advisor_enabled;

-- A consultation is kept so an answer can be reopened and its sources checked
-- later. Carries the tenancy triple like everything else, so it is reached
-- through the same predicate.
CREATE TABLE consultations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question   text NOT NULL,
  synthesis  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX consultations_owner ON consultations (owner_id, created_at DESC);

CREATE TABLE consultation_answers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE CASCADE,
  profile_id      text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  -- Denormalised: the advisor may be renamed or deleted, and a past answer
  -- should still say who gave it.
  advisor_name    text NOT NULL,
  answer          text NOT NULL,
  -- The passages actually passed to the model. Exact — a fact about our own
  -- retrieval rather than something the model reported.
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ordinal         integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX consultation_answers_parent ON consultation_answers (consultation_id, ordinal);
