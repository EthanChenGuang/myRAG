import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishStage } from '@/lib/rag/ingest/stages/publish';
import { softDeleteLineage } from '@/lib/rag/ingest/soft-delete';
import type { StageContext } from '@/lib/rag/ingest/types';
import type { PublishResult } from '@/lib/rag/ingest/writer';
import type { SemanticCache } from '@/lib/rag/cache/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { SCOPE_A, SCOPE_B } from './fixtures';
import { fakeRpc } from './fake-rpc';

const DOC_NEW = '00000000-0000-4000-8000-00000000d101';
const DOC_OLD = '00000000-0000-4000-8000-00000000d100';
const LINEAGE = '00000000-0000-4000-8000-00000000c101';

interface Invalidation {
  scope: TenantScope;
  documentIds: string[] | undefined;
}

function recordingCache(events: string[], behaviour: 'resolve' | 'hang' | 'reject' = 'resolve'): {
  cache: SemanticCache;
  invalidations: Invalidation[];
} {
  const invalidations: Invalidation[] = [];
  const cache: SemanticCache = {
    check: async () => null,
    store: async () => undefined,
    invalidateTenant: (scope, documentIds) => {
      events.push('invalidate');
      invalidations.push({ scope, documentIds });
      if (behaviour === 'hang') return new Promise<number>(() => undefined);
      if (behaviour === 'reject') return Promise.reject(new Error('sidecar down'));
      return Promise.resolve(1);
    },
  };
  return { cache, invalidations };
}

function useBackend(backend: 'off' | 'pgvector' | 'redisvl', cache: SemanticCache): void {
  setRagDepsForTests({
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: backend }),
    semanticCache: () => cache,
  });
}

function publishContext(
  events: string[],
  publish: () => Promise<PublishResult>,
  scope: TenantScope = SCOPE_A,
): StageContext {
  return {
    input: { scope } as StageContext['input'],
    writer: {
      publish: async () => {
        const result = await publish();
        events.push('publish');
        return result;
      },
    } as unknown as StageContext['writer'],
    document: { id: DOC_NEW, version: 2, lineageId: LINEAGE, resumed: false },
    parserUsed: 'text',
    work: { chunksWritten: 3 } as StageContext['work'],
    warnings: [],
  } as unknown as StageContext;
}

const PUBLISHED: PublishResult = { outcome: 'published', documentId: DOC_NEW, version: 2, supersededDocumentId: null };

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('publish stage: RedisVL invalidation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  it('with redisvl, a successful publish invalidates the tenant and document once, after the RPC', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend('redisvl', cache);
    const outcome = await publishStage.run(publishContext(events, async () => PUBLISHED));
    await flush();
    expect(outcome.kind).toBe('done');
    expect(invalidations).toEqual([{ scope: SCOPE_A, documentIds: [DOC_NEW] }]);
    expect(events).toEqual(['publish', 'invalidate']);
  });

  it('includes the superseded version, and uses the publishing tenant only', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend('redisvl', cache);
    await publishStage.run(
      publishContext(events, async () => ({ ...PUBLISHED, supersededDocumentId: DOC_OLD }), SCOPE_B),
    );
    await flush();
    expect(invalidations).toEqual([{ scope: SCOPE_B, documentIds: [DOC_NEW, DOC_OLD] }]);
  });

  it('does not await the invalidation on the ingest path', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events, 'hang');
    useBackend('redisvl', cache);
    const outcome = await publishStage.run(publishContext(events, async () => PUBLISHED));
    expect(outcome.kind).toBe('done');
    await flush();
    expect(invalidations).toHaveLength(1);
  });

  it('a failing invalidation does not fail the publish', async () => {
    const events: string[] = [];
    const { cache } = recordingCache(events, 'reject');
    useBackend('redisvl', cache);
    const outcome = await publishStage.run(publishContext(events, async () => PUBLISHED));
    await flush();
    expect(outcome).toMatchObject({ kind: 'done', result: { status: 'ready', documentId: DOC_NEW } });
  });

  it.each(['pgvector', 'off'] as const)('with %s, no call is made', async (backend) => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend(backend, cache);
    await publishStage.run(publishContext(events, async () => PUBLISHED));
    await flush();
    expect(invalidations).toHaveLength(0);
  });

  it('a failed publish makes no call', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend('redisvl', cache);
    await expect(
      publishStage.run(publishContext(events, async () => { throw new Error('publish failed'); })),
    ).rejects.toThrow();
    await flush();
    expect(invalidations).toHaveLength(0);
  });
});

describe('soft delete: RedisVL invalidation', () => {
  afterEach(() => {
    resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  function softDeleteDb(outcome: 'deleted' | 'already_deleted' | 'error') {
    return fakeRpc(() =>
      outcome === 'error'
        ? { data: null, error: { message: 'tenant_mismatch', code: '22023' } }
        : { data: [{ outcome, lineage_id: LINEAGE, job_id: null }], error: null },
    );
  }

  it('with redisvl, a successful soft delete invalidates the whole tenant once', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend('redisvl', cache);
    const db = softDeleteDb('deleted');
    const result = await softDeleteLineage(SCOPE_A, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => db.client } });
    await flush();
    expect(result.ok).toBe(true);
    expect(invalidations).toEqual([{ scope: SCOPE_A, documentIds: undefined }]);
  });

  it('a repeated soft delete (already_deleted) still emits', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend('redisvl', cache);
    const db = softDeleteDb('already_deleted');
    await softDeleteLineage(SCOPE_B, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => db.client } });
    await flush();
    expect(invalidations).toEqual([{ scope: SCOPE_B, documentIds: undefined }]);
  });

  it('does not await the invalidation, and a failing one does not fail the delete', async () => {
    for (const behaviour of ['hang', 'reject'] as const) {
      const events: string[] = [];
      const { cache, invalidations } = recordingCache(events, behaviour);
      useBackend('redisvl', cache);
      const db = softDeleteDb('deleted');
      const result = await softDeleteLineage(SCOPE_A, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => db.client } });
      await flush();
      expect(result.ok).toBe(true);
      expect(invalidations).toHaveLength(1);
    }
  });

  it.each(['pgvector', 'off'] as const)('with %s, no call is made', async (backend) => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend(backend, cache);
    const db = softDeleteDb('deleted');
    await softDeleteLineage(SCOPE_A, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => db.client } });
    await flush();
    expect(invalidations).toHaveLength(0);
  });

  it('a failed soft delete makes no call', async () => {
    const events: string[] = [];
    const { cache, invalidations } = recordingCache(events);
    useBackend('redisvl', cache);
    const db = softDeleteDb('error');
    const result = await softDeleteLineage(SCOPE_A, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => db.client } });
    await flush();
    expect(result.ok).toBe(false);
    expect(invalidations).toHaveLength(0);
  });
});
