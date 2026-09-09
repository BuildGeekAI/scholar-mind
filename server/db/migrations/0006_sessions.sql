-- 0006 — browser sessions from Google sign-in.
--
-- Replaces IAP as the way a person proves who they are. IAP gates access
-- through GCP IAM, so every user needs a role grant in the project — which
-- cannot deliver self-serve signup, and needs a Load Balancer and certificates
-- in front of Cloud Run to exist at all.
--
-- Sessions are rows rather than a self-contained signed token, for the same
-- reason API keys are: a row can be revoked. A signed cookie stays valid until
-- it expires no matter what happens to the account behind it.

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the cookie value. The cookie itself is never stored, so a
  -- leaked database is not a set of live sessions.
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  -- Diagnostics only: "which of these is my laptop" on a sessions screen.
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user    ON sessions (user_id);
CREATE INDEX sessions_expiry  ON sessions (expires_at);

-- Google's subject claim: stable for a Google account forever, and unlike the
-- address it never changes hands. `users.external_id` holds it once a person
-- has signed in with Google.
ALTER TABLE users ADD COLUMN picture text;
