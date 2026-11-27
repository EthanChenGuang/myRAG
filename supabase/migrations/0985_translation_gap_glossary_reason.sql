-- 0985 (Phase 6.2, XLG-05 D-14): a chunk translation that loses a required glossary term after the one deterministic correction is not
-- stored; the producer records it as a gap with reason glossary_term_lost, so the job finishes and the chunk is not retried until its
-- source changes (or an admin rebuild clears the gap). Additive and idempotent: only the reason CHECK of chunk_translation_gaps widens.
-- Needs 0820. Not folded into the setup files.

DO $gap_reason_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.chunk_translation_gaps') IS NULL THEN
    RAISE EXCEPTION '0985: apply 0820 first' USING ERRCODE = '55000';
  END IF;
END
$gap_reason_precheck$;

ALTER TABLE public.chunk_translation_gaps DROP CONSTRAINT IF EXISTS chunk_translation_gaps_reason_check;
ALTER TABLE public.chunk_translation_gaps ADD CONSTRAINT chunk_translation_gaps_reason_check
  CHECK (reason IN ('too_long', 'protected_token_lost', 'empty_output', 'invalid_output', 'glossary_term_lost'));
