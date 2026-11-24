-- Keeps the pictures of ingested documents out of bucket listings (Phase 3, plan 03-38, D-29).
-- Pictures found inside PDFs are stored in the public chat-images bucket under rag/<tenant_key>/<lineage_id>/<version>/p<page>-<n>.<ext>.
-- A public bucket serves its objects by URL without any storage.objects policy. The SELECT policy of the setup files ("Chat images are
-- publicly accessible", bucket_id = 'chat-images') additionally lets every client, the anon key included, LIST the whole bucket, which
-- would show any signed-in tenant the keys, and so the URLs, of every other tenant's document pictures. This narrows the policy so that
-- nothing under rag/ can be listed or downloaded through the storage API with the anon or a user key. The URLs the chat streams as
-- source_images keep working, and the service key (the ingest writer, the only writer under rag/) bypasses the policy.
-- Both deployment modes share the policy name. Idempotent: safe to run more than once.
-- Run in the Supabase SQL editor as the postgres role BEFORE switching RAG_PDF_IMAGE_CHUNKS on.
-- To undo: recreate the policy with USING (bucket_id = 'chat-images').

BEGIN;

DROP POLICY IF EXISTS "Chat images are publicly accessible" ON storage.objects;
CREATE POLICY "Chat images are publicly accessible"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'chat-images' AND name NOT LIKE 'rag/%');

COMMIT;
