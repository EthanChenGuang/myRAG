-- 0935: empty placeholder (claimed by plan 04.4-16). 04.2-40's 0936 redefines rag_bm25_search_chunks after this number, so plan 04.4-17
-- wrote p_df_mode in 0938_bm25_search_df_mode.sql instead. This file must stay empty.
-- Idempotent; not folded into the setup files.

BEGIN;
COMMIT;
