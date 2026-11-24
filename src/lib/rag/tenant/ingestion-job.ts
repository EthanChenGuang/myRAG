import { getDeploymentMode } from '@/lib/deployment-mode';
import type { RpcClient } from '../backend/supabase-rpc';
import { getJobInternal } from '../ingest/ledger';
import { mintScope, type TenantScope } from './scope';

export interface ScopeFromIngestionJobDeps {
  db: () => RpcClient | null;
  signal: AbortSignal;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
}

const TENANT_KEY_RE = /^(?:s:default|([uo]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/i;

/**
 * Mint the tenant scope for a ledger job. The tenant always comes from the job row, never from the caller (D-07).
 */
export async function scopeFromIngestionJob(
  jobId: string,
  deps: ScopeFromIngestionJobDeps,
): Promise<TenantScope | null> {
  const job = await getJobInternal(jobId, { signal: deps.signal, deps: { db: deps.db } });
  if (!job) {
    console.warn('[RAG Tenant] job scope refused', { reason: 'job_not_found' });
    return null;
  }

  const match = TENANT_KEY_RE.exec(job.tenant_key);
  if (!match) {
    console.warn('[RAG Tenant] job scope refused', { reason: 'invalid_tenant_key' });
    return null;
  }

  const mode = deps.deploymentMode ?? getDeploymentMode();
  if (job.tenant_key === 's:default') {
    if (mode !== 'single-tenant') {
      console.warn('[RAG Tenant] job scope refused', { reason: 'single_in_multi' });
      throw new Error('[RAG Tenant] single tenant key in multi-tenant mode');
    }
    return mintScope('single', null, null);
  }

  const id = match[2]!.toLowerCase();
  if (match[1] === 'u') return mintScope('personal', id, null);
  return mintScope('org', null, id);
}