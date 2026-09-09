-- 0008 — record which provider a person signed in with.
--
-- `external_id` already carries a prefixed identity ('firebase:<uid>'), so
-- nothing structural changes. The column exists so the provider is a value in
-- the row rather than something inferred by parsing a string prefix — the kind
-- of implicit contract that breaks quietly when a second provider appears.
ALTER TABLE users ADD COLUMN auth_provider text NOT NULL DEFAULT 'unknown';

UPDATE users
   SET auth_provider = split_part(external_id, ':', 1)
 WHERE external_id LIKE '%:%';
