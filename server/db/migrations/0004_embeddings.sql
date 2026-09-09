-- deferrable
-- 0004 — semantic retrieval alongside the keyword index.
--
-- Separate from 0003 because it needs one number this repository does not know:
-- the output dimension of `gemini-embedding-2`. It appears nowhere in the code
-- except as a File Search configuration string, so it has to be measured rather
-- than assumed:
--
--     GEMINI_API_KEY=... npm run spike:postgres      # check G2 prints it
--     EMBEDDING_DIM=<that number> npm run db:migrate
--
-- The migration runner refuses to apply this file without EMBEDDING_DIM set. A
-- wrong dimension is not a soft failure — every insert would be rejected, and
-- changing it later means rebuilding the whole index.
--
-- Marked `deferrable` above: it only adds a column to a table 0003 created and
-- nothing later depends on it, so skipping it lets subsequent migrations apply
-- normally. Without that marker a skip stops the run, because applying a later
-- migration first would leave the schema in an order these files do not describe.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks ADD COLUMN embedding vector(${EMBEDDING_DIM});

-- HNSW over cosine distance: the embeddings are normalised, and cosine is what
-- the retrieval task type is trained for.
CREATE INDEX chunks_embedding ON chunks
  USING hnsw (embedding vector_cosine_ops);
