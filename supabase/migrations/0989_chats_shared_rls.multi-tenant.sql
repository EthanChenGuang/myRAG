-- NF-1 (multi-tenant): a user reads only their own personal chats and their own chats in organizations they belong to;
-- shared = true no longer widens SELECT across users or tenants. Idempotent.

DROP POLICY IF EXISTS "Users can view chats" ON public.chats;
CREATE POLICY "Users can view chats" ON public.chats
  FOR SELECT USING (
    -- Own personal chats
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational chats
    (user_id = auth.uid() AND organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );
