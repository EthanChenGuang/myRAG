import type { RpcClient } from '../backend/supabase-rpc';
import type { EmbeddingProfile } from '../embeddings/active-profile';
import { embedQueriesForEvalProfile } from '../embeddings/query-embedding';
import { QueryVectorRowSchema } from '@/lib/rag-eval/contracts.generated';
import { readBundleManifest, readKeptQueries, vectorFileBase, withStagedSets, type KeptQuery } from './bundle-io';
import { assertBundleConsent } from './export-vectors';

export const DEFAULT_QUERY_BATCH_SIZE = 64;

export interface EmbedQueriesOptions {
  db: RpcClient;
  bundleDir: string;
  profile: EmbeddingProfile;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface EmbedQueriesReport {
  profileId: string;
  batches: number;
  tenants: { tenantKey: string; rows: number }[];
}

/**
 * Embeds every kept query of the bundle (train, dev, test, mined) with the profile's production query path through @/lib/rag and
 * writes, per tenant, vectors/query-vectors.<tenant>.<profile>.f32 plus .rows.jsonl (QueryVectorRow, ids only) and .header.json, in
 * input order. Consent is re-checked first; a profile mismatch from the provider fails the command and nothing is written.
 */
export async function embedBundleQueries(options: EmbedQueriesOptions): Promise<EmbedQueriesReport> {
  const { db, bundleDir, profile } = options;
  const batchSize = options.batchSize ?? DEFAULT_QUERY_BATCH_SIZE;
  const signal = options.signal ?? new AbortController().signal;
  const manifest = readBundleManifest(bundleDir);
  await assertBundleConsent(db, manifest, signal);
  const queries = readKeptQueries(bundleDir, manifest);

  const byTenant = new Map<string, KeptQuery[]>();
  for (const tenantKey of manifest.tenant_keys) byTenant.set(tenantKey, []);
  for (const query of queries) byTenant.get(query.tenantKey)?.push(query);

  return withStagedSets(async (stage) => {
    let batches = 0;
    const tenants: EmbedQueriesReport['tenants'] = [];
    for (const [tenantKey, list] of byTenant) {
      if (list.length === 0) continue;
      const set = stage(vectorFileBase('queries', tenantKey, profile.id), { tenantKey, profileId: profile.id, model: profile.model, dims: profile.dims });
      for (let start = 0; start < list.length; start += batchSize) {
        signal.throwIfAborted();
        const batch = list.slice(start, start + batchSize);
        const embeddings = await embedQueriesForEvalProfile(batch.map((query) => query.text), signal, profile);
        batches += 1;
        embeddings.forEach((embedding, index) => {
          const row = QueryVectorRowSchema.parse({
            pair_id: batch[index].pairId,
            query_id: null,
            profile_id: profile.id,
            model: profile.model,
            dims: profile.dims,
            vector: embedding.vector,
          });
          set.append(embedding.vector, row);
        });
      }
      tenants.push({ tenantKey, rows: set.rows });
    }
    return { profileId: profile.id, batches, tenants };
  }, bundleDir);
}
