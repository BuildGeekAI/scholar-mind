-- 0001 — multi-tenant foundation.
--
-- Replaces the Firestore document model. Three things this schema does that the
-- old one could not: it puts the authorization check and the data it guards in
-- one query, it gives the pipeline a durable place to record work, and it lets a
-- paper's visibility be a property of the row rather than a property of which
-- collection it happens to live in.
--
-- Ids: profiles, papers and messages keep TEXT ids because they are minted by
-- the application (crypto.randomUUID, or a search result's identity) and already
-- appear inside blob keys, which must keep resolving. Everything new uses uuid.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --- Enums -------------------------------------------------------------------

CREATE TYPE visibility     AS ENUM ('private', 'team', 'org');
CREATE TYPE principal_type AS ENUM ('user', 'team', 'org');
CREATE TYPE grant_role     AS ENUM ('viewer', 'editor', 'owner');
CREATE TYPE member_role    AS ENUM ('member', 'admin');

-- --- Tenancy -----------------------------------------------------------------

CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  -- The identity `identity.ts` resolved: an IAP subject, the API user id, or
  -- the dev user. Stable across sessions, which is why it is the natural key.
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id  text NOT NULL UNIQUE,
  email        text NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  slug       text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       member_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE team_members (
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       member_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX org_members_user  ON org_members (user_id);
CREATE INDEX team_members_user ON team_members (user_id);

-- --- Profiles and their contents ---------------------------------------------

CREATE TABLE profiles (
  id                     text PRIMARY KEY,
  org_id                 uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  team_id                uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  owner_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Public by default, read as "every member of the owner's org".
  visibility             visibility NOT NULL DEFAULT 'org',
  title                  text NOT NULL,
  emoji                  text NOT NULL DEFAULT '📒',
  theme                  text NOT NULL DEFAULT 'Ocean',
  scholar_name           text,
  affiliation            text,
  topics                 text[] NOT NULL DEFAULT '{}',
  file_search_store_name text,
  -- Every identity this profile's scholar is known by; the duplicate check
  -- reads it before a search is allowed to write anything.
  scholar_keys           text[] NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profiles_org          ON profiles (org_id);
CREATE INDEX profiles_owner        ON profiles (owner_id);
CREATE INDEX profiles_team         ON profiles (team_id);
CREATE INDEX profiles_updated      ON profiles (updated_at DESC);
CREATE INDEX profiles_scholar_keys ON profiles USING GIN (scholar_keys);

-- One paper per row, mirroring the `Paper` interface field for field. The
-- lifecycle columns stay as they are — `status` for artifact generation,
-- `index_status` for indexing, `pdf_status` for acquisition — because the two
-- halves of the pipeline are independent and neither may clobber the other.
-- `stage` is the transient step within a run; unlike Firestore, clearing it is
-- just a NULL, so the withDeletions workaround is gone.
CREATE TABLE papers (
  id                  text NOT NULL,
  profile_id          text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  kind                text NOT NULL DEFAULT 'paper',
  title               text NOT NULL,
  year                text,
  authors             text[] NOT NULL DEFAULT '{}',
  summary             text,
  citation_count      text,
  status              text NOT NULL DEFAULT 'discovered',
  stage               text,
  pdf_status          text,
  index_status        text,
  indexed_kind        text,
  pdf_reused          boolean NOT NULL DEFAULT false,
  blog_title          text,
  blog_content        text,
  audio_script        text,
  slides              jsonb,
  quiz                jsonb,
  flash_cards         jsonb,
  citing_papers       jsonb,
  citation_meta       jsonb,
  illustration_key    text,
  illustration_mime   text,
  audio_key           text,
  audio_mime          text,
  pdf_key             text,
  media_key           text,
  media_mime          text,
  file_name           text,
  source_url          text,
  extracted_text      text,
  duration_seconds    double precision,
  file_search_doc_name text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX papers_profile ON papers (profile_id);
CREATE INDEX papers_title   ON papers (lower(title));

CREATE TABLE messages (
  id         text NOT NULL,
  profile_id text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  role       text NOT NULL,
  content    text NOT NULL,
  citations  jsonb,
  timestamp  bigint NOT NULL,
  PRIMARY KEY (profile_id, id)
);

CREATE INDEX messages_profile_ts ON messages (profile_id, timestamp);

-- --- Shared corpus -----------------------------------------------------------
-- Deliberately outside the tenancy model. It holds only public open-access
-- content — a resolved URL and the PDF bytes — and never anything
-- profile-specific. Scoping it per org would break the cross-profile reuse that
-- makes the second index of a paper skip resolution and download entirely.
CREATE TABLE corpus (
  key           text PRIMARY KEY,
  title         text NOT NULL,
  pdf_blob_key  text,
  source_url    text,
  pdf_status    text,
  first_seen_at bigint NOT NULL,
  updated_at    bigint NOT NULL,
  reuse_count   integer NOT NULL DEFAULT 0
);

-- --- Sharing -----------------------------------------------------------------
-- Additive on top of `visibility`: a grant can only widen access, never narrow
-- it. Polymorphic on resource_type so papers and crawlers can be shared later
-- without another table.
CREATE TABLE resource_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type  text NOT NULL,
  resource_id    text NOT NULL,
  principal_type principal_type NOT NULL,
  principal_id   uuid NOT NULL,
  role           grant_role NOT NULL DEFAULT 'viewer',
  granted_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, principal_type, principal_id)
);

CREATE INDEX resource_grants_principal ON resource_grants (principal_type, principal_id);
CREATE INDEX resource_grants_resource  ON resource_grants (resource_type, resource_id);

-- --- Seed: demo/demo/demo ----------------------------------------------------
-- The starting tenancy. `identity.ts` maps every caller here until real orgs
-- exist, so a fresh database is immediately usable.
INSERT INTO orgs (id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'demo', 'Demo Organization');

INSERT INTO teams (id, org_id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001', 'demo', 'Demo Team');

INSERT INTO users (id, external_id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000003', 'dev-user', 'dev@localhost', 'Demo User');

INSERT INTO org_members (org_id, user_id, role)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000003', 'admin');

INSERT INTO team_members (team_id, user_id, role)
VALUES ('00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003', 'admin');
