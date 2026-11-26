import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENQUEUE_REVIEW_RPC, enqueueReviewItem, type EnqueueReviewItemDeps } from '@/lib/rag/feedback-loop/enqueue-item';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';

const TENANT = 'o:00000000-0000-4000-8000-0000000000aa';
const CHUNK_A = '00000000-0000-4000-8000-00000000000a';
const CHUNK_B = '00000000-0000-4000-8000-00000000000b';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const ITEM = '00000000-0000-4000-8000-0000000000f1';

function harness(result: { data: unknown; error: unknown } | Error = { data: ITEM, error: null }, enabled = true) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const deps: EnqueueReviewItemDeps = {
    enabled: () => enabled,
    log: (line) => lines.push(line),
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { calls, lines, deps };
}

const INPUT = {
  tenantKey: TENANT,
  reason: 'output_guard' as const,
  sourceChunkIds: [CHUNK_B, CHUNK_A.toUpperCase(), CHUNK_B],
  documentIds: [DOC],
  detector: 'rules',
  traceId: 'trace-0001',
};

afterEach(() => {
  resetRagDepsForTests();
  vi.unstubAllEnvs();
});

describe('enqueueReviewItem (D-55)', () => {
  it('makes no RPC call and returns null while the expert review queue is off', async () => {
    const { calls, lines, deps } = harness(undefined, false);
    await expect(enqueueReviewItem(INPUT, deps)).resolves.toBeNull();
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('reads RAG_DOMAIN_EXPERT_REVIEW at call time by default', async () => {
    const { calls, deps } = harness();
    const withoutSwitch: EnqueueReviewItemDeps = { rpc: deps.rpc, log: deps.log };
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    await expect(enqueueReviewItem(INPUT, withoutSwitch)).resolves.toBeNull();
    expect(calls).toEqual([]);
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
    await expect(enqueueReviewItem(INPUT, withoutSwitch)).resolves.toBe(ITEM);
    expect(calls).toHaveLength(1);
  });

  it('sends one RPC with the tenant, reason, sorted distinct ids and an id-only snapshot, and returns the item id', async () => {
    const { calls, lines, deps } = harness();
    await expect(enqueueReviewItem(INPUT, deps)).resolves.toBe(ITEM);
    expect(calls).toEqual([
      {
        fn: ENQUEUE_REVIEW_RPC,
        args: {
          p_tenant_key: TENANT,
          p_reason: 'output_guard',
          p_source: { chunk_ids: [CHUNK_A, CHUNK_B], document_ids: [DOC] },
          p_snapshot: { detector: 'rules', trace_id: 'trace-0001' },
        },
      },
    ]);
    expect(ENQUEUE_REVIEW_RPC).toBe('rag_enqueue_review_item');
    expect(lines).toEqual([]);
  });

  it('leaves out a detector or trace id that is not an id token instead of failing the call', async () => {
    const { calls, deps } = harness();
    await enqueueReviewItem({ tenantKey: TENANT, reason: 'version_conflict', documentIds: [DOC], detector: 'Two words', traceId: 'a sentence with spaces' }, deps);
    expect(calls[0]?.args).toEqual({
      p_tenant_key: TENANT,
      p_reason: 'version_conflict',
      p_source: { chunk_ids: [], document_ids: [DOC] },
      p_snapshot: {},
    });
  });

  it('returns null without a call when there is no id to send or no admin client', async () => {
    const empty = harness();
    await expect(enqueueReviewItem({ tenantKey: TENANT, reason: 'claim_unsupported' }, empty.deps)).resolves.toBeNull();
    expect(empty.calls).toEqual([]);
    expect(empty.lines).toHaveLength(1);

    setRagDepsForTests({ adminClient: () => null });
    const lines: string[] = [];
    await expect(enqueueReviewItem(INPUT, { enabled: () => true, log: (line) => lines.push(line) })).resolves.toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Review]');
  });

  it('uses the admin client from the RAG deps by default', async () => {
    const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(async () => ({ data: ITEM, error: null }));
    setRagDepsForTests({ adminClient: () => ({ rpc }) as never });
    await expect(enqueueReviewItem(INPUT, { enabled: () => true, log: () => undefined })).resolves.toBe(ITEM);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe('rag_enqueue_review_item');
  });

  it('an RPC error or a throw returns null and logs one line with the reason, the code and the ids, never a message', async () => {
    for (const result of [
      { data: null, error: { code: '22023', message: 'secret database detail' } },
      new Error('secret thrown detail'),
      { data: 42, error: null },
    ]) {
      const { lines, deps } = harness(result);
      await expect(enqueueReviewItem(INPUT, deps)).resolves.toBeNull();
      expect(lines).toHaveLength(1);
      const line = lines[0] as string;
      expect(line.startsWith('[Review]')).toBe(true);
      expect(line).toContain('output_guard');
      expect(line).toContain(CHUNK_A);
      expect(line).toContain(DOC);
      expect(line).not.toContain('secret');
    }
  });

  it('a null result (tenant opted out) is returned as null without a log line', async () => {
    const { lines, deps } = harness({ data: null, error: null });
    await expect(enqueueReviewItem(INPUT, deps)).resolves.toBeNull();
    expect(lines).toEqual([]);
  });
});
