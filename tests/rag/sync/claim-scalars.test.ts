import { describe, expect, it } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { checkpointRow, completeRows, failRow } from '@/lib/rag/sync/claim';

/** Answers every call with the given data, the way PostgREST (bare) or the PGlite edge (one keyed row) would. */
function answering(shape: 'bare' | 'keyed', values: Record<string, unknown>): RpcClient {
  return {
    rpc(fn: string): RpcRequest {
      const value = values[fn];
      const data = shape === 'bare' ? value : [{ [fn]: value }];
      const run = Promise.resolve<RpcResponse>({ data, error: null });
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

describe.each(['bare', 'keyed'] as const)('outbox scalar RPCs read both answer shapes (%s)', (shape) => {
  it('completeRows returns the completed count', async () => {
    expect(await completeRows(answering(shape, { rag_vector_sync_complete: 3 }), [1, 2, 3])).toBe(3);
  });

  it('failRow returns the row state', async () => {
    expect(await failRow(answering(shape, { rag_vector_sync_fail: 'dead' }), 7, 'store_error')).toBe('dead');
  });

  it('checkpointRow returns whether the row was found', async () => {
    expect(await checkpointRow(answering(shape, { rag_vector_sync_checkpoint: true }), 7, 'cursor-1')).toBe(true);
  });
});
