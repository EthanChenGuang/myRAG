import { getWhatsAppClient } from '@/lib/whatsapp/client-factory';
import { linkPreviewStatus } from '@/lib/rag/security/security-admin';
import { admitSecurityActor, jsonNoStore } from '../_responses';

export const runtime = 'nodejs';

/**
 * D-40, UI-SPEC 6.13.3: the WhatsApp service's link-preview hosts against RAG_OUTPUT_LINK_ALLOWLIST. Deployment configuration, so
 * deployment admins only. Host names only; nothing is fetched from them.
 */
export async function GET(request: Request): Promise<Response> {
  const admission = await admitSecurityActor(request, { deploymentAdminOnly: true });
  if (!admission.ok) return admission.response;

  const status = await linkPreviewStatus({
    previewHosts: async () => {
      try {
        return await getWhatsAppClient().getLinkPreviewHosts();
      } catch {
        return null;
      }
    },
    allowlistValue: process.env.RAG_OUTPUT_LINK_ALLOWLIST,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  });
  console.log('[RAG Admin] link previews checked', { state: status.state, hosts: status.preview_hosts?.length ?? 0 });
  return jsonNoStore({
    success: true,
    state: status.state,
    preview_hosts: status.preview_hosts ?? [],
    hosts_not_allowlisted: status.hosts_not_allowlisted ?? [],
  });
}
