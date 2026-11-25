import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FingerprintImpactSchema, type IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

const ENV_KEYS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE', 'RAG_TABLE_HEADER_REPEAT', 'RAG_INGEST_ASYNC', 'RAG_INGEST_PIPELINE'] as const;
const savedEnv: Record<string, string | undefined> = {};

const state = {
  admin: { ok: true, userId: 'admin-1' } as { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string },
  checkCalls: 0,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcome: { data: [], error: null } as RpcOutcome,
  dbAvailable: true,
};

function rpcClient() {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(state.outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', () => ({
    checkAdmin: async () => {
      state.checkCalls += 1;
      return state.admin;
    },
    adminDenied: (status: number) =>
      new Response(JSON.stringify({ success: false, error: 'denied' }), { status, headers: { 'content-type': 'application/json' } }),
  }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => (state.dbAvailable ? (rpcClient() as never) : null) });
  const fp = await import('@/lib/rag/ingest/fingerprint');
  const impact = await import('@/app/api/rag/admin/ingest-fingerprint/impact/route');
  return { fp, impact };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function parts(loaded: Loaded, docType: string, parser: 'docling' | 'llamaparse', headerRepeat: 'profile' | 'always' = 'profile'): IngestFingerprintParts {
  const seed: IngestFingerprintParts = {
    parser_used: parser,
    parser_version: '1.0.0',
    processing_profile_id: `${docType}@1`,
    processing_profile_version: 1,
    ocr_engine_codes: [],
    chunking_profile_id: 'legacy',
    lexical_version: 2,
    embedding_text_version: 1,
    embedding_profile_id: 'openai-3-small-1536',
    embedding_profile_version: 1,
    language_pack_versions: {},
    switches: { language_aware_ingest: 'off', table_header_repeat: headerRepeat, table_row_serialization: 'false', caption_language: 'en' },
  };
  return loaded.fp.expectedFingerprintFor(seed, { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' }).parts;
}

function group(loaded: Loaded, docType: string, parser: 'docling' | 'llamaparse', documents: number, headerRepeat: 'profile' | 'always' = 'profile'): Row {
  const stored = parts(loaded, docType, parser, headerRepeat);
  return { doc_type: docType, ingest_fingerprint: loaded.fp.buildIngestFingerprint(stored), parts: stored, documents };
}

function post(body: unknown, raw?: string): Request {
  return new Request('http://localhost/api/rag/admin/ingest-fingerprint/impact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

describe('ingest-fingerprint admin routes', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
    process.env.RAG_PRIMARY_LANGUAGE = 'zh';
    delete process.env.RAG_TABLE_HEADER_REPEAT;
    delete process.env.RAG_INGEST_ASYNC;
    delete process.env.RAG_INGEST_PIPELINE;
    state.admin = { ok: true, userId: 'admin-1' };
    state.checkCalls = 0;
    state.rpcCalls = [];
    state.outcome = { data: [], error: null };
    state.dbAvailable = true;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.doUnmock('@/lib/admin-route-auth');
  });

  describe('POST /api/rag/admin/ingest-fingerprint/impact', () => {
    it.each([401, 403, 503] as const)('answers %s without reading the database when the admin guard refuses', async (status) => {
      const loaded = await load();
      state.admin = { ok: false, status, reason: 'x' };
      const response = await loaded.impact.POST(post({ proposed: { RAG_TABLE_HEADER_REPEAT: 'always' } }));
      expect(response.status).toBe(status);
      expect(state.checkCalls).toBe(1);
      expect(state.rpcCalls).toEqual([]);
    });

    it('answers the FingerprintImpact shape with the affected counts per mechanism and doc type', async () => {
      const loaded = await load();
      state.outcome = {
        data: [
          group(loaded, 'general', 'docling', 4),
          group(loaded, 'financial_report', 'docling', 2),
          group(loaded, 'contract_legal', 'llamaparse', 1),
          { doc_type: 'general', ingest_fingerprint: null, parts: null, documents: 3 },
        ],
        error: null,
      };
      const response = await loaded.impact.POST(post({ proposed: { RAG_TABLE_HEADER_REPEAT: 'always', RAG_RERANKER: 'cohere' } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = FingerprintImpactSchema.parse(await response.json());
      expect(body.ingestion_keys).toEqual(['RAG_TABLE_HEADER_REPEAT']);
      const counts = Object.fromEntries(body.by_mechanism.filter((row) => row.affected > 0).map((row) => [`${row.mechanism}:${row.doc_type}`, row.affected]));
      expect(counts).toEqual({ 'rechunk:general': 4, 'rechunk:contract_legal': 1 });
      expect(body.without_fingerprint).toBe(3);
      expect(body.total_current).toBe(10);
      expect(state.rpcCalls).toEqual([{ fn: 'rag_fingerprint_groups', args: { p_tenant_key: null } }]);
    });

    it('zero affected documents answers 0 for every mechanism', async () => {
      const loaded = await load();
      state.outcome = { data: [group(loaded, 'financial_report', 'docling', 2)], error: null };
      const response = await loaded.impact.POST(post({ proposed: { RAG_TABLE_HEADER_REPEAT: 'always' } }));
      const body = FingerprintImpactSchema.parse(await response.json());
      expect(body.by_mechanism.length).toBe(6);
      expect(body.by_mechanism.every((row) => row.affected === 0)).toBe(true);
    });

    it.each([
      ['an unknown key', { proposed: { NOT_A_SETTING: 'x' } }],
      ['a lower-case key', { proposed: { rag_table_header_repeat: 'always' } }],
      ['a non-string value', { proposed: { RAG_TABLE_HEADER_REPEAT: 1 } }],
      ['an extra top-level field', { proposed: {}, tenant: 'u:someone' }],
      ['a missing proposed object', {}],
      ['an over-long value', { proposed: { RAG_TABLE_HEADER_REPEAT: 'x'.repeat(5000) } }],
    ])('refuses %s with 400 and never reads the database', async (_name, body) => {
      const loaded = await load();
      const response = await loaded.impact.POST(post(body));
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
      expect(state.rpcCalls).toEqual([]);
    });

    it('refuses a body that is not JSON with 400', async () => {
      const loaded = await load();
      const response = await loaded.impact.POST(post(undefined, '{not json'));
      expect(response.status).toBe(400);
    });

    it('answers 503 when the admin client is missing or the read fails, without leaking the database message', async () => {
      const loaded = await load();
      state.dbAvailable = false;
      expect((await loaded.impact.POST(post({ proposed: { RAG_TABLE_HEADER_REPEAT: 'always' } }))).status).toBe(503);
      state.dbAvailable = true;
      state.outcome = { data: null, error: { code: 'P0001', message: 'secret internal detail' } };
      const response = await loaded.impact.POST(post({ proposed: { RAG_TABLE_HEADER_REPEAT: 'always' } }));
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain('secret internal detail');
    });
  });
});
