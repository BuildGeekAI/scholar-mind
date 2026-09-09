-- 0005 — per-user API keys.
--
-- The deployment previously had exactly one key, mapping to one configured
-- user. That was fine when there was one tenant; under org/team/user it means
-- every API caller resolves to the same identity, so sharing a key is sharing
-- an account and the ACL model stops applying to anything but the browser.
--
-- A key belongs to a person and acts as that person. It therefore inherits
-- their grants exactly, and there is no second authorization model to keep in
-- sync with the first.

CREATE TYPE api_key_scope AS ENUM ('read', 'write');

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES orgs (id)  ON DELETE CASCADE,
  -- What the user called it: "laptop", "CI", "Claude Desktop".
  name         text NOT NULL,
  -- The public half, stored in clear so a presented key is found with one
  -- indexed lookup rather than by hashing against every row in the table.
  prefix       text NOT NULL UNIQUE,
  -- SHA-256 of the whole key. The key itself is shown once, at creation, and
  -- is not recoverable afterwards — a leaked database must not be a leaked
  -- set of credentials.
  hash         text NOT NULL,
  scope        api_key_scope NOT NULL DEFAULT 'read',
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_user ON api_keys (user_id, created_at DESC);
-- The lookup path: live keys only.
CREATE INDEX api_keys_live ON api_keys (prefix) WHERE revoked_at IS NULL;
