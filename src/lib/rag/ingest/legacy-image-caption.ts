import { isMultiTenant } from '@/lib/deployment-mode';
import { getKbLanguageShares } from '../query/kb-languages';
import { storeScopeForTenantKey } from '../tenant/store-scope';
import { resolveCaptionLanguage, type ShareLookup } from './caption-language';
import { captionImage } from './captioner';
import { loadIngestConfig } from './config';
import { getIngestDeps } from './deps';

export interface LegacyImageOwner {
  userId?: string | null;
  organizationId?: string | null;
}

/** The tenant key the legacy writer's row gets (documents.tenant_key follows user_id and organization_id). */
function legacyTenantKey(owner: LegacyImageOwner): string | null {
  if (!isMultiTenant()) return 's:default';
  if (owner.organizationId) return `o:${owner.organizationId.toLowerCase()}`;
  if (owner.userId) return `u:${owner.userId.toLowerCase()}`;
  return null;
}

const defaultShares: ShareLookup = async (tenantKey) => {
  const shares = await getKbLanguageShares(storeScopeForTenantKey(tenantKey));
  if (shares === null) throw new Error('shares_unavailable');
  return Object.entries(shares).map(([language, share]) => ({ language, share: share as number }));
};

/**
 * XLG-06 on the legacy image upload (processImageDocument). With RAG_CAPTION_LANGUAGE=en (default) it returns null and the caller keeps
 * its own caption call unchanged. With `document` the caption goes through captionImage with the D-23 target: an image has no text, so
 * the language with the largest share of the uploader's tenant, else RAG_PRIMARY_LANGUAGE.
 */
export async function captionLegacyImage(
  bytes: Uint8Array,
  mimeType: string,
  owner: LegacyImageOwner,
  options: { lookupShares?: ShareLookup } = {},
): Promise<string | null> {
  const config = loadIngestConfig(getIngestDeps().ingestEnv());
  if (config.captionLanguage !== 'document') return null;
  const tenantKey = legacyTenantKey(owner);
  const language = await resolveCaptionLanguage({
    documentLanguage: null,
    tenantKey,
    ...(tenantKey !== null ? { lookupShares: options.lookupShares ?? defaultShares } : {}),
  });
  return captionImage(bytes, mimeType, language === null ? {} : { targetLanguage: language });
}
