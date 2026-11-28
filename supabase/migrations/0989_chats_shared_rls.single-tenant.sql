-- NF-1 (single-tenant): a user reads only their own chats; shared = true no longer widens SELECT. Idempotent.

DROP POLICY IF EXISTS "Users can view their own chats" ON public.chats;
CREATE POLICY "Users can view their own chats"
  ON public.chats FOR SELECT
  USING ((SELECT auth.uid()) = user_id);
