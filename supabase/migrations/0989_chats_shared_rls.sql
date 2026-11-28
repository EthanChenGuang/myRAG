-- NF-1: chats SELECT policies no longer let anon or any signed-in user read every shared = true row through PostgREST.
-- Shared links are served by the service-role page and route, which match one share_id; no client role reads shared chats.
-- Common part: drop the public shared policy in both modes (the single-tenant setup created it; IF EXISTS keeps it idempotent).
-- The mode files recreate each mode's SELECT policy without the shared branch. Idempotent.

DROP POLICY IF EXISTS "Allow public access to shared chats" ON public.chats;
