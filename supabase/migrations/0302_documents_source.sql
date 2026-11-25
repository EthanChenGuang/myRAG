-- 0302: widen documents.source to chat_upload | config_upload | nango | scraper | image_upload | ai_to_rag (Phase 3, D-06 with F-1).
-- The old CHECK is found through pg_constraint because the live name may differ from the committed one (the committed CHECK cannot hold
-- the values today's writers send, so a live project has probably been altered by hand). Old values map as follows:
--   upload -> config_upload; google-drive / notion / dropbox -> nango (source_provider filled from the old value when empty);
--   scrape -> scraper; anything else, or NULL -> config_upload.
-- A value that changed is kept in metadata.legacy_source.

BEGIN;

DO $$
DECLARE
  source_attnum smallint;
  check_name text;
BEGIN
  SELECT attnum INTO source_attnum
  FROM pg_attribute
  WHERE attrelid = to_regclass('public.documents') AND attname = 'source' AND NOT attisdropped;
  FOR check_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass('public.documents') AND contype = 'c' AND conkey @> ARRAY[source_attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.documents DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

UPDATE documents
SET metadata = CASE
      WHEN source IS NULL OR (metadata IS NOT NULL AND metadata->'legacy_source' IS NOT NULL) THEN metadata
      ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('legacy_source', source)
    END,
    source_provider = CASE
      WHEN COALESCE(source_provider, '') = '' AND source IN ('google-drive', 'notion', 'dropbox') THEN source
      ELSE source_provider
    END,
    source = CASE
      WHEN source IN ('google-drive', 'notion', 'dropbox') THEN 'nango'
      WHEN source = 'scrape' THEN 'scraper'
      ELSE 'config_upload'
    END
WHERE source IS NULL OR source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag');

ALTER TABLE documents ALTER COLUMN source SET DEFAULT 'config_upload';

ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag'));

COMMIT;
