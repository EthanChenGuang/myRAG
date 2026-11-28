import type { RpcClient } from '../backend/supabase-rpc';
import type { EmbeddingProfile } from '../embeddings/active-profile';
import { canonicalModelId } from '../embeddings/registry';
import { ChunkVectorRowSchema } from '@/lib/rag-eval/contracts.generated';
import { readBundleManifest, vectorFileBase, withStagedSets, type DatasetManifest } from './bundle-io';

export const EXPORT_RPC = 'rag_finetune_export_vectors';
export const CONSENT_RPC = 'rag_finetune_consent_for_export';
export const DEFAULT_EXPORT_PAGE_SIZE = 500;

export type FinetuneRefusalCode = 'consent' | 'unbound' | 'unknown_profile' | 'tenant_key_invalid' | 'database' | 'vector_shape' | 'model_mismatch';

/** A refusal from the database or a shape check. detail never carries row text. */
export class FinetuneRefusal extends Error {
  constructor(
    readonly code: FinetuneRefusalCode,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FinetuneRefusal';
  }
}

interface RpcErrorLike {
  message?: string;
  code?: string;
}

function refusalFrom(error: RpcErrorLike): FinetuneRefusal {
  const message = error.message ?? '';
  if (/^(export_refused|consent_refused): consent/.test(message) || error.code === '42501') return new FinetuneRefusal('consent', error.code ?? null);
  if (/^export_refused: unbound/.test(message)) return new FinetuneRefusal('unbound');
  if (/^export_refused: unknown_profile/.test(message)) return new FinetuneRefusal('unknown_profile');
  if (/^tenant_key_invalid/.test(message)) return new FinetuneRefusal('tenant_key_invalid');
  return new FinetuneRefusal('database', error.code ?? null);
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : [];
}

/** Re-checks that every tenant of the bundle granted consent covering the manifest's purpose (D-27). Throws FinetuneRefusal('consent'). */
export async function assertBundleConsent(db: RpcClient, manifest: DatasetManifest, signal?: AbortSignal): Promise<void> {
  let request = db.rpc(CONSENT_RPC, { p_tenant_keys: manifest.tenant_keys, p_purpose: manifest.purpose });
  if (signal) request = request.abortSignal(signal);
  const { error } = await request;
  if (error) throw refusalFrom(error);
}

export interface ExportVectorsOptions {
  db: RpcClient;
  bundleDir: string;
  profile: EmbeddingProfile;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface ExportVectorsReport {
  profileId: string;
  tenants: { tenantKey: string; rows: number }[];
}

/**
 * Writes, for every tenant of the bundle manifest, the profile's stored vectors of that tenant's current, ready chunks:
 * vectors/<tenant>.<profile>.f32 (row-major float32 little-endian), .rows.jsonl (ChunkVectorRow) and .header.json (VectorFileHeader).
 * Every page goes through rag_finetune_export_vectors, which is bound to one tenant and checks consent itself; the files appear only
 * when every tenant succeeded.
 */
export async function exportVectors(options: ExportVectorsOptions): Promise<ExportVectorsReport> {
  const { db, bundleDir, profile, signal } = options;
  const pageSize = options.pageSize ?? DEFAULT_EXPORT_PAGE_SIZE;
  const manifest = readBundleManifest(bundleDir);
  await assertBundleConsent(db, manifest, signal);

  return withStagedSets(async (stage) => {
    const tenants: ExportVectorsReport['tenants'] = [];
    for (const tenantKey of manifest.tenant_keys) {
      const set = stage(vectorFileBase('chunks', tenantKey, profile.id), { tenantKey, profileId: profile.id, model: profile.model, dims: profile.dims });
      let after: string | null = null;
      for (;;) {
        signal?.throwIfAborted();
        let request = db.rpc(EXPORT_RPC, {
          p_tenant_key: tenantKey,
          p_purpose: manifest.purpose,
          p_profile_id: profile.id,
          p_after: after,
          p_limit: pageSize,
        });
        if (signal) request = request.abortSignal(signal);
        const { data, error } = await request;
        if (error) throw refusalFrom(error);
        const page = rowsOf(data);
        for (const raw of page) {
          const vector = raw.embedding;
          if (!Array.isArray(vector) || vector.length !== profile.dims || raw.dims !== profile.dims) {
            throw new FinetuneRefusal('vector_shape', `row ${set.rows}`);
          }
          if (canonicalModelId(String(raw.embedding_model)) !== canonicalModelId(profile.model)) {
            throw new FinetuneRefusal('model_mismatch', `row ${set.rows}`);
          }
          const row = ChunkVectorRowSchema.parse({
            tenant_key: tenantKey,
            chunk_id: String(raw.chunk_id),
            row_index: set.rows,
            profile_id: profile.id,
            model: String(raw.embedding_model),
            dims: profile.dims,
          });
          set.append(vector as number[], row);
        }
        if (page.length < pageSize) break;
        after = String(page[page.length - 1].chunk_id);
      }
      tenants.push({ tenantKey, rows: set.rows });
    }
    return { profileId: profile.id, tenants };
  }, bundleDir);
}
