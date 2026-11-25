import { z } from 'zod/v3';
import type { RpcClient } from '../../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../../tenant/scope';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';
import { getIngestDeps } from '../deps';
import { IngestStageError, type StageContext } from '../types';
import { MAX_DOCUMENT_SCOPES, SCOPE_DIMENSIONS, type ScopeDimension } from './admin';

/**
 * Scope tags chosen by the uploader (DATA-18, D-40). The route calls validateUploadScopes before anything is stored: tags count only under
 * the unified pipeline with RAG_SCOPE_TAGS on, and only values of the tenant's active vocabulary. The pipeline then calls applyUploadScopes
 * once the version's document row exists and before any chunk is written, so the chunk writers copy the tags onto every chunk. Tags are a
 * retrieval filter, never access control. Logs carry counts and codes only, never a tag.
 */

const TAG = /^(region|legal_entity|department):[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Longest tag string accepted before the vocabulary check: a dimension, a colon and a 64-character slug. */
const MAX_TAG_LENGTH = 'legal_entity'.length + 1 + 64;

/** The upload form's tags: one dimension:value string per tag (UI-SPEC 6.11). Format only; the vocabulary check follows. */
export const UploadScopeTagSchema = z.string().trim().max(MAX_TAG_LENGTH).regex(TAG);
export const UploadScopesSchema = z.array(UploadScopeTagSchema);

/** Tags count for an upload only under the unified pipeline with RAG_SCOPE_TAGS on (D-40); otherwise the picker is hidden. */
export function uploadScopesEnabled(config: Pick<IngestConfig, 'pipeline' | 'scopeTags'> = currentIngestConfig()): boolean {
  return config.pipeline === 'unified' && config.scopeTags;
}

export interface UploadVocabularyEntry {
  dimension: ScopeDimension;
  value: string;
  label: string;
}

export type UploadScopeFailure = 'unknown_scope_value' | 'too_many_scopes' | 'unavailable';

export type UploadVocabularyResult = { ok: true; items: UploadVocabularyEntry[] } | { ok: false; reason: 'unavailable' };

function isDimension(value: unknown): value is ScopeDimension {
  return typeof value === 'string' && (SCOPE_DIMENSIONS as readonly string[]).includes(value);
}

function dimensionRank(dimension: ScopeDimension): number {
  return SCOPE_DIMENSIONS.indexOf(dimension);
}

/** The active entries of the scope's own tenant, by dimension then label (then value). The tenant key comes from the minted scope only. */
export async function activeUploadVocabulary(scope: TenantScope, options: { signal: AbortSignal }): Promise<UploadVocabularyResult> {
  assertTenantScope(scope);
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    options.signal.throwIfAborted();
    const response = await db.rpc('rag_scope_vocabulary_for', { p_tenant_key: scopeKey(scope).toLowerCase() }).abortSignal(options.signal);
    if (response.error) {
      console.error('[Ingest] upload scope vocabulary read failed', { code: response.error.code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    const items: UploadVocabularyEntry[] = [];
    for (const row of (Array.isArray(response.data) ? response.data : []) as Array<Record<string, unknown>>) {
      const { dimension, value, label, active } = row;
      if (active !== true) continue;
      if (!isDimension(dimension) || typeof value !== 'string' || typeof label !== 'string') {
        console.error('[Ingest] upload scope vocabulary row malformed');
        return { ok: false, reason: 'unavailable' };
      }
      items.push({ dimension, value, label });
    }
    items.sort(
      (a, b) =>
        dimensionRank(a.dimension) - dimensionRank(b.dimension) ||
        (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0) ||
        (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
    return { ok: true, items };
  } catch (error) {
    console.error('[Ingest] upload scope vocabulary read failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

export type ValidateUploadScopesResult =
  /** scopes is undefined when the upload carries no tags or tags are ignored (switch off or legacy pipeline). */
  | { ok: true; scopes: string[] | undefined; ignored: boolean }
  | { ok: false; reason: UploadScopeFailure };

/** One warning per request when tags arrive where they are not used; the count only. */
export function warnUploadScopesIgnored(count: number, reason: 'scope_tags_off' | 'legacy_pipeline' | 'not_ingested'): void {
  if (count > 0) console.warn('[Ingest] upload scope tags ignored', { count, reason });
}

/**
 * Route-side check, before any document row or stored object exists. Switch off or legacy pipeline: the tags are ignored with one warning
 * and the upload proceeds as one without them. Otherwise every tag must be dimension:value of an active entry of the scope's own tenant
 * (unknown_scope_value), at most MAX_DOCUMENT_SCOPES distinct tags (too_many_scopes). A vocabulary that cannot be read is unavailable.
 */
export async function validateUploadScopes(
  scope: TenantScope,
  raw: readonly unknown[],
  options: { signal: AbortSignal; config?: Pick<IngestConfig, 'pipeline' | 'scopeTags'> },
): Promise<ValidateUploadScopesResult> {
  if (raw.length === 0) return { ok: true, scopes: undefined, ignored: false };
  const config = options.config ?? currentIngestConfig();
  if (!uploadScopesEnabled(config)) {
    warnUploadScopesIgnored(raw.length, config.pipeline === 'unified' ? 'scope_tags_off' : 'legacy_pipeline');
    return { ok: true, scopes: undefined, ignored: true };
  }
  const parsed = UploadScopesSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'unknown_scope_value' };
  const tags = [...new Set(parsed.data)];
  if (tags.length > MAX_DOCUMENT_SCOPES) return { ok: false, reason: 'too_many_scopes' };
  const vocabulary = await activeUploadVocabulary(scope, { signal: options.signal });
  if (!vocabulary.ok) return { ok: false, reason: 'unavailable' };
  const known = new Set(vocabulary.items.map((entry) => `${entry.dimension}:${entry.value}`));
  if (tags.some((tag) => !known.has(tag))) return { ok: false, reason: 'unknown_scope_value' };
  return { ok: true, scopes: tags.sort(), ignored: false };
}

const SQL_REASONS = new Set(['unknown_scope_value', 'too_many_scopes', 'not_found', 'invalid_argument']);

/**
 * Writes the upload's tags on a version that is still being ingested (rag_set_upload_scopes, 0817), which checks them again against the
 * tenant's active vocabulary. Used by file_hash_dedup and by the progressive final begin; the tenant key is the scope's own.
 */
export async function writeUploadScopes(
  db: RpcClient,
  tenantKey: string,
  documentId: string,
  scopes: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const response = await db
    .rpc('rag_set_upload_scopes', { p_document_id: documentId, p_tenant_key: tenantKey, p_scopes: [...scopes] })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    const word = /^[a-z_]+/.exec(response.error.message ?? '')?.[0];
    const reason = word !== undefined && SQL_REASONS.has(word) ? word : 'scope_write_failed';
    console.error('[Ingest] upload scope tags not stored', { reason, code: response.error.code ?? null });
    throw new IngestStageError('file_hash_dedup', reason);
  }
}

/**
 * Stage hook: the version's document row exists (ctx.document) and no chunk is written yet. No tags: nothing is called, as today. With
 * RAG_SCOPE_TAGS switched off since the route checked, the tags are dropped with one warning.
 */
export async function applyUploadScopes(ctx: StageContext): Promise<void> {
  const scopes = ctx.input.scopes;
  if (!scopes || scopes.length === 0 || !ctx.document || !ctx.identity) return;
  if (!uploadScopesEnabled(ctx.config)) {
    warnUploadScopesIgnored(scopes.length, ctx.config.pipeline === 'unified' ? 'scope_tags_off' : 'legacy_pipeline');
    return;
  }
  const db = ctx.deps.db();
  if (!db) throw new IngestStageError('file_hash_dedup', 'db_unavailable');
  await writeUploadScopes(db, ctx.identity.tenantKey, ctx.document.id, scopes, ctx.signal);
}
