import { RetrievalBackendError, rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { runStage, type StageSpec } from '../pipeline';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';

/** The recheck result carried on the search output and the retrieval result (D-46); the trace's stale_index_drop is `dropped`. */
export interface SourceRecheckMarker {
  checked: number;
  dropped: number;
}

export interface SourceRecheckResult extends SourceRecheckMarker {
  kept: ReadonlySet<string>;
}

export interface SourceRecheckOptions {
  client: RpcClient;
  signal: AbortSignal;
}

/** The SQL function's limit per call; a larger candidate set is sent in consecutive batches. */
export const SOURCE_RECHECK_MAX_IDS = 500;
const RPC_NAME = 'rag_source_recheck';

/**
 * The ids among chunkIds whose chunk and document are in the scope's tenant, current and ready (D-19). The tenant key is the scope's
 * and nothing else; no ids, no call.
 */
export async function sourceRecheck(scope: TenantScope, chunkIds: readonly string[], options: SourceRecheckOptions): Promise<SourceRecheckResult> {
  assertTenantScope(scope);
  const unique = [...new Set(chunkIds)];
  const kept = new Set<string>();
  if (unique.length === 0) return { kept, checked: 0, dropped: 0 };
  const { client, signal } = options;
  const tenantKey = scopeKey(scope).toLowerCase();
  for (let start = 0; start < unique.length; start += SOURCE_RECHECK_MAX_IDS) {
    signal.throwIfAborted();
    const response = await client
      .rpc(RPC_NAME, { p_tenant_key: tenantKey, p_chunk_ids: unique.slice(start, start + SOURCE_RECHECK_MAX_IDS) })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) throw new RetrievalBackendError(RPC_NAME, response.error.code ?? null);
    for (const row of rpcRows(response.data)) {
      const id = typeof row === 'object' && row !== null ? (row as { chunk_id?: unknown }).chunk_id : undefined;
      if (typeof id === 'string') kept.add(id);
    }
  }
  return { kept, checked: unique.length, dropped: unique.filter((id) => !kept.has(id)).length };
}

export interface SourceRecheckStageInput<T> {
  spec: StageSpec;
  signal: AbortSignal;
  collector: TraceCollector;
  scope: TenantScope;
  client: () => RpcClient;
  items: readonly T[];
  chunkIdOf: (item: T) => string;
}

export interface SourceRecheckStageOutput<T> {
  items: T[];
  /** Absent when the stage did not complete: the items then continue unchecked and the stage record says why (D-38). */
  marker: SourceRecheckMarker | null;
}

function failureDetail(unchecked: number) {
  return (error: unknown): string => {
    const code = error instanceof RetrievalBackendError ? (error.code ?? 'unknown') : 'unknown';
    return `unchecked=${unchecked};error=${code}`;
  };
}

/**
 * The source_recheck stage, shared by every retrieval path: one recheck of the candidate set, the candidates that failed it removed,
 * counts on the stage record and the marker returned. A failure or timeout skips the stage (the result is degraded) and keeps every
 * candidate, unchecked and without a marker. A non-zero drop logs counts only; no repair request is sent (D-20, D-47).
 */
export async function runSourceRecheckStage<T>(input: SourceRecheckStageInput<T>): Promise<SourceRecheckStageOutput<T>> {
  const { spec, signal, collector, scope, items, chunkIdOf } = input;
  const outcome = await runStage(
    spec,
    signal,
    (stageSignal) => sourceRecheck(scope, items.map(chunkIdOf), { client: input.client(), signal: stageSignal }),
    collector,
    {
      candidatesIn: items.length,
      candidatesOut: (value) => items.filter((item) => value.kept.has(chunkIdOf(item))).length,
      counts: (value) => ({ stale_index_drop: value.dropped, checked: value.checked }),
      failureDetail: failureDetail(items.length),
    },
  );
  if (outcome.skipped) return { items: [...items], marker: null };
  const { kept, checked, dropped } = outcome.value;
  if (dropped > 0) console.info('[Document Search] Source recheck dropped stale candidates', { dropped, checked });
  return { items: items.filter((item) => kept.has(chunkIdOf(item))), marker: { checked, dropped } };
}
