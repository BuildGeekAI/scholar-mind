-- 0003 — the reverse index.
--
-- This is what makes sharing searchable. File Search cannot be scoped below a
-- store, app-defined metadata filters silently match nothing, and a single call
-- accepts at most five stores — all verified against the live API. Under an ACL
-- model the visible set differs per viewer and routinely exceeds five profiles,
-- so a store boundary can no longer express it. Here the ACL predicate is just
-- another clause in the same query.
--
-- Chunks rather than whole documents, because a citation should point at the
-- passage that supports the claim, not at the paper it appeared in.

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  paper_id    text NOT NULL,
  source_kind text NOT NULL DEFAULT 'paper',
  title       text NOT NULL,
  /** 'pdf' when the full text was indexed, 'summary' when only prose was. */
  body_kind   text NOT NULL DEFAULT 'summary',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Re-indexing a paper replaces its document rather than accumulating copies.
  UNIQUE (profile_id, paper_id),
  FOREIGN KEY (profile_id, paper_id) REFERENCES papers (profile_id, id) ON DELETE CASCADE
);

CREATE INDEX documents_profile ON documents (profile_id);

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  text        text NOT NULL,
  -- Generated, so it can never drift from the text it indexes.
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);

CREATE INDEX chunks_tsv      ON chunks USING GIN (tsv);
CREATE INDEX chunks_document ON chunks (document_id);
