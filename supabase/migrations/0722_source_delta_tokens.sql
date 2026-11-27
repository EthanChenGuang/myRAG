-- 0722: Phase 6.3 change-feed cursor store (D-21, DATA-25).
-- rag_source_delta_tokens keeps one cursor per (connection, feed, feed_key): the Microsoft Graph @odata.deltaLink /
-- nextLink per drive (feed 'graph_delta', feed_key = drive id) and the Nango records cursor per model
-- (feed 'nango_records', feed_key = model). It never holds access tokens, file names or file content, only cursor URLs.
-- Server role only: RLS on, no policies, no client grants. Additive and idempotent; not folded into the setup files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_source_delta_tokens (
  connection_id uuid NOT NULL REFERENCES public.nango_connections(id) ON DELETE CASCADE,
  feed text NOT NULL,
  feed_key text NOT NULL,
  delta_link text,
  next_link text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, feed, feed_key),
  CONSTRAINT rag_source_delta_tokens_feed_check CHECK (feed IN ('graph_delta', 'nango_records')),
  CONSTRAINT rag_source_delta_tokens_feed_key_length CHECK (length(feed_key) BETWEEN 1 AND 256),
  CONSTRAINT rag_source_delta_tokens_delta_link_length CHECK (delta_link IS NULL OR length(delta_link) <= 4096),
  CONSTRAINT rag_source_delta_tokens_next_link_length CHECK (next_link IS NULL OR length(next_link) <= 4096)
);

ALTER TABLE public.rag_source_delta_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rag_source_delta_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rag_source_delta_tokens TO service_role;

COMMIT;
