import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { SemanticCache } from '@/lib/rag/cache/types';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { approveUpload } from '@/lib/rag/ingest/approval/admin';
import { importAttributeRows } from '@/lib/rag/ingest/attributes/apply';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { setDocumentScopes } from '@/lib/rag/ingest/scopes/admin';
import { applyEffectiveDates, recordExtractedEffectiveDates } from '@/lib/rag/ingest/versions/effective-dates';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { fakeRpc } from './fake-rpc';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const TENANT = 'u:00000000-0000-4000-8000-0000000000b1';
const DOC = '00000000-0000-4000-8000-00000000d201';
const DOC_OLD = '00000000-0000-4000-8000-00000000d200';
const DOC_OTHER = '00000000-0000-4000-8000-00000000d202';

interface Invalidation {
  tenantKey: string;
  documentIds: string[] | undefined;
}

function recordingCache(): { cache: SemanticCache; invalidations: Invalidation[] } {
  const invalidations: Invalidation[] = [];
  const cache: SemanticCache = {
    check: async () => null,
    store: async () => undefined,
    invalidateTenant: async (scope, documentIds) => {
      invalidations.push({ tenantKey: scopeKey(scope), documentIds });
      return 1;
    },
  };
  return { cache, invalidations };
}

const RESPONSES: Record<string, (args: Record<string, unknown>) => RpcResponse> = {
  rag_set_document_scopes: () => ({ data: [{ document_id: DOC, scopes: ['area:alpha'], chunks_updated: 2 }], error: null }),
  rag_approve_upload: () => ({ data: [{ document_id: DOC, version: 2, outcome: 'published', superseded_document_id: DOC_OLD }], error: null }),
  rag_set_document_effective_dates: () => ({
    data: [{ document_id: DOC, outcome: 'set', effective_from: '2026-01-01', effective_to: null, chunks_updated: 2 }],
    error: null,
  }),
  rag_import_document_attributes: (args) => ({
    data: [
      {
        documents_changed: args.p_dry_run ? 0 : 2,
        documents_unchanged: 0,
        chunks_updated: 4,
        staged: 0,
        staged_unchanged: 0,
        changed_document_ids: [DOC, DOC_OTHER],
        outbox_rows: 0,
      },
    ],
    error: null,
  }),
};

function useBackend(backend: 'off' | 'pgvector' | 'redisvl', cache: SemanticCache, failing = false): RpcClient {
  const db = fakeRpc((fn, args) => {
    if (failing) return { data: null, error: { message: 'synthetic failure', code: 'XX000' } };
    const respond = RESPONSES[fn];
    return respond ? respond(args) : { data: [], error: null };
  });
  const lookup = {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        abortSignal: () => chain,
        maybeSingle: async () => ({ data: { tenant_key: TENANT }, error: null }),
      };
      return chain;
    },
  };
  setRagDepsForTests({
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: backend }),
    semanticCache: () => cache,
    adminClient: () => lookup as never,
  });
  setIngestDepsForTests({ db: () => db.client });
  return db.client;
}

const signal = () => new AbortController().signal;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type Writer = { name: string; run: (db: RpcClient) => Promise<unknown>; expected: string[] };

const WRITERS: Writer[] = [
  {
    name: 'scope tags (setDocumentScopes)',
    run: () => setDocumentScopes({ actorUserId: ACTOR, tenantKey: TENANT, signal: signal(), documentId: DOC, scopes: ['area:alpha'] }),
    expected: [DOC],
  },
  {
    name: 'admin effective dates (applyEffectiveDates)',
    run: () => applyEffectiveDates({ actorUserId: ACTOR, tenantKey: TENANT, signal: signal(), documentId: DOC, from: '2026-01-01', to: null }),
    expected: [DOC],
  },
  {
    name: 'extracted effective dates (recordExtractedEffectiveDates)',
    run: () =>
      recordExtractedEffectiveDates({
        documentId: DOC,
        tenantKey: TENANT,
        proposal: { from: '2026-01-01', to: null, confidence: 0.99 },
        current: { origin: null },
        now: new Date('2026-11-28T00:00:00Z'),
      }),
    expected: [DOC],
  },
  {
    name: 'upload approval (approveUpload)',
    run: () => approveUpload({ actorUserId: ACTOR, tenantKey: TENANT, signal: signal(), documentId: DOC }),
    expected: [DOC, DOC_OLD],
  },
  {
    name: 'attribute import (importAttributeRows)',
    run: (db) =>
      importAttributeRows(db, TENANT, [{ source: 'sample', sourceKey: 'k1', attributes: { area: ['alpha'] } }], {
        dryRun: false,
        signal: signal(),
        config: loadIngestConfig({}),
      }),
    expected: [DOC, DOC_OTHER],
  },
];

describe('in-place document writers: RedisVL invalidation (SC7, CACHE-01)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetRagDepsForTests();
    resetIngestDepsForTests();
    vi.restoreAllMocks();
  });

  it.each(WRITERS)('$name: with redisvl, a successful write invalidates the writer tenant and its documents', async (writer) => {
    const { cache, invalidations } = recordingCache();
    const db = useBackend('redisvl', cache);
    const result = (await writer.run(db)) as { ok: boolean };
    await flush();
    expect(result.ok).toBe(true);
    expect(invalidations).toEqual([{ tenantKey: TENANT, documentIds: writer.expected }]);
  });

  it.each(WRITERS.flatMap((writer) => (['pgvector', 'off'] as const).map((backend) => ({ ...writer, backend }))))(
    '$name: with $backend, nothing is sent',
    async (writer) => {
      const { cache, invalidations } = recordingCache();
      const db = useBackend(writer.backend, cache);
      const result = (await writer.run(db)) as { ok: boolean };
      await flush();
      expect(result.ok).toBe(true);
      expect(invalidations).toEqual([]);
    },
  );

  it.each(WRITERS)('$name: a failed write sends nothing', async (writer) => {
    const { cache, invalidations } = recordingCache();
    const db = useBackend('redisvl', cache, true);
    const result = (await writer.run(db)) as { ok: boolean };
    await flush();
    expect(result.ok).toBe(false);
    expect(invalidations).toEqual([]);
  });

  it('an attribute dry run sends nothing', async () => {
    const { cache, invalidations } = recordingCache();
    const db = useBackend('redisvl', cache);
    const result = await importAttributeRows(db, TENANT, [{ source: 'sample', sourceKey: 'k1', attributes: { area: ['alpha'] } }], {
      dryRun: true,
      signal: signal(),
      config: loadIngestConfig({}),
    });
    await flush();
    expect(result.ok).toBe(true);
    expect(invalidations).toEqual([]);
  });
});
