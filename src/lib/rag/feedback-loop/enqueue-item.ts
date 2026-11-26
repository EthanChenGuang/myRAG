import { getRagDeps } from '../deps';
import { readFeedbackLoopConfig } from './config';

/** The immediate route into the review queue (D-55); service role only (0944, locked again in 0410). */
export const ENQUEUE_REVIEW_RPC = 'rag_enqueue_review_item';

export type EnqueueReviewReason = 'claim_unsupported' | 'output_guard' | 'version_conflict';

export interface EnqueueReviewItemInput {
  tenantKey: string;
  reason: EnqueueReviewReason;
  sourceChunkIds?: readonly string[];
  documentIds?: readonly string[];
  detector?: string | null;
  traceId?: string | null;
}

type RpcResult = { data: unknown; error: unknown };

export interface EnqueueReviewItemDeps {
  /** Defaults to the admin client's rpc from the RAG deps. */
  rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  /** Defaults to RAG_DOMAIN_EXPERT_REVIEW read at call time. */
  enabled?: () => boolean;
  log?: (line: string) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DETECTOR_RE = /^[a-z][a-z0-9_]{0,31}$/;
const TRACE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9_]{1,32}$/;

function sortedIds(ids: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const id of ids ?? []) {
    if (typeof id === 'string') out.add(id.trim().toLowerCase());
  }
  return [...out].sort();
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE_RE.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && ERROR_CODE_RE.test(name)) return name;
  }
  return 'unknown';
}

function defaultLog(line: string): void {
  console.warn(line);
}

/**
 * Hands a finding to the Phase 5.1.1 review queue at once when RAG_DOMAIN_EXPERT_REVIEW is on. Sends ids only (the SQL refuses any
 * text key), never throws, and returns the item id, or null when the queue is off, the tenant opted out or the call failed.
 */
export async function enqueueReviewItem(input: EnqueueReviewItemInput, deps: EnqueueReviewItemDeps = {}): Promise<string | null> {
  const log = deps.log ?? defaultLog;
  const chunkIds = sortedIds(input.sourceChunkIds);
  const documentIds = sortedIds(input.documentIds);
  const fail = (code: string): null => {
    log(`[Review] enqueue failed (${code}) reason=${input.reason} chunks=${chunkIds.filter((id) => UUID_RE.test(id)).join(',')} documents=${documentIds.filter((id) => UUID_RE.test(id)).join(',')}`);
    return null;
  };
  try {
    const enabled = deps.enabled ? deps.enabled() : readFeedbackLoopConfig(process.env, log).domainExpertReview;
    if (!enabled) return null;
    if (chunkIds.length === 0 && documentIds.length === 0) return fail('no_ids');

    let rpc = deps.rpc;
    if (!rpc) {
      const client = getRagDeps().adminClient();
      if (!client) return fail('no_admin_client');
      rpc = (fn, args) => client.rpc(fn, args) as unknown as PromiseLike<RpcResult>;
    }

    const snapshot: Record<string, string> = {};
    if (typeof input.detector === 'string' && DETECTOR_RE.test(input.detector)) snapshot.detector = input.detector;
    if (typeof input.traceId === 'string' && TRACE_RE.test(input.traceId)) snapshot.trace_id = input.traceId;

    const { data, error } = await rpc(ENQUEUE_REVIEW_RPC, {
      p_tenant_key: input.tenantKey,
      p_reason: input.reason,
      p_source: { chunk_ids: chunkIds, document_ids: documentIds },
      p_snapshot: snapshot,
    });
    if (error) return fail(errorCode(error));
    if (data === null || data === undefined) return null;
    if (typeof data !== 'string' || !UUID_RE.test(data.toLowerCase())) return fail('unexpected_result');
    return data;
  } catch (error) {
    return fail(errorCode(error));
  }
}
