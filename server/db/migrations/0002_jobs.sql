-- 0002 — the work queue and the crawl runs it serves.
--
-- Acquisition, enrichment and indexing move out of the request path. The job
-- row *is* the status the client polls, so there is no second status store to
-- keep in sync, and enqueueing happens in the same transaction as the write
-- that caused it.

CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');

-- A crawler definition: "where does this library's content come from, and how
-- often should we go and look again".
CREATE TABLE crawlers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id    text REFERENCES profiles (id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'scholar',
  -- What to crawl: a Google Scholar URL, a scholar's name, a feed URL.
  target        text NOT NULL,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL means manual-only. Otherwise a plain interval in seconds; a cron
  -- expression would need a parser, and "every N hours" is the actual need.
  interval_seconds integer,
  enabled       boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crawlers_profile ON crawlers (profile_id);
CREATE INDEX crawlers_due     ON crawlers (next_run_at) WHERE enabled;

-- One execution instance. This is the thing a user watches: "I asked for this
-- scholar's papers at 14:02, here is how far it has got."
CREATE TABLE crawl_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawler_id  uuid REFERENCES crawlers (id) ON DELETE SET NULL,
  profile_id  text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  triggered_by uuid REFERENCES users (id) ON DELETE SET NULL,
  kind        text NOT NULL,
  status      run_status NOT NULL DEFAULT 'queued',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crawl_runs_profile ON crawl_runs (profile_id, created_at DESC);

CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES crawl_runs (id) ON DELETE CASCADE,
  parent_job_id uuid REFERENCES jobs (id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Identifies the unit of work, so re-enqueueing the same paper while it is
  -- still pending is a no-op rather than a duplicate.
  dedupe_key    text,
  status        job_status NOT NULL DEFAULT 'queued',
  priority      integer NOT NULL DEFAULT 0,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_at     timestamptz,
  -- A worker that dies mid-job stops heartbeating; the reaper requeues it.
  heartbeat_at  timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The claim query's index: queued rows, oldest eligible first within priority.
CREATE INDEX jobs_claimable ON jobs (priority DESC, run_after)
  WHERE status = 'queued';
CREATE INDEX jobs_run       ON jobs (run_id);
CREATE INDEX jobs_stale     ON jobs (heartbeat_at) WHERE status = 'running';

-- Partial, so the same key can be enqueued again once the previous attempt has
-- settled — a paper genuinely can need re-indexing later.
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Append-only timeline. Finer-grained than the SSE frames it replaces: the UI
-- can show which stage a paper is in, not merely that something is happening.
CREATE TABLE job_events (
  id      bigserial PRIMARY KEY,
  job_id  uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  status  text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX job_events_job ON job_events (job_id, at);
