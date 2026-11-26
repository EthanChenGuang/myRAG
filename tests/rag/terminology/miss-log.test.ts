import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { runRetrieval } from '@/lib/rag';
import type { RefusalRecord } from '@/lib/rag/refusal/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { MISS_LOG_TIMEOUT_MS, recordMiss, shouldRecordMiss, type MissLogInput } from '@/lib/rag/terminology/miss-log';
import type { Candidate } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { fakeAssemblyAdmin, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

vi.mock('@/lib/rag/embeddings/query-embedding', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/embeddings/query-embedding')>();
  return { ...original, embedQuery: async () => ({ vector: [0.1, 0.2, 0.3], profile: null }) };
});

const ORG = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-0000000000aa';
const scope = mintScope('org', USER, ORG);
const TENANT = `o:${ORG}`;
const HASH = 'f'.repeat(64);
const CODES = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config/rag/language-packs.json'), 'utf8')) as { packs: { code: string }[] }).packs.map(
  (pack) => pack.code,
);
const LANGUAGES = { RAG_SUPPORTED_LANGUAGES: CODES.join(','), RAG_PRIMARY_LANGUAGE: CODES[0]! };

// Fake values from tests/rag/mask.test.ts.
const FAKE_EMAIL = 'jane.doe+kb@example.co.uk';
const FAKE_PHONE = '+44 20 7946 0958';

interface Call {
  fn: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

function recordingClient(options: { hang?: boolean; error?: boolean; ignoreAbort?: boolean } = {}): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      const call: Call = { fn, args };
      calls.push(call);
      const request: RpcRequest = {
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return request;
        },
        then(onFulfilled, onRejected) {
          const settled = new Promise<RpcResponse>((resolve) => {
            if (fn !== 'rag_term_record_miss') return resolve({ data: [], error: null });
            if (options.hang) {
              if (!options.ignoreAbort) call.signal?.addEventListener('abort', () => resolve({ data: null, error: { message: 'aborted' } }), { once: true });
              return;
            }
            resolve(options.error ? { data: null, error: { message: 'boom', code: 'P0001' } } : { data: '00000000-0000-4000-8000-000000000001', error: null });
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function candidate(score: number): Candidate {
  return {
    chunk_id: `c-${score}`,
    document_id: 'd-1',
    content: 'synthetic text',
    similarity: score,
    metadata: {},
    temporal_score: 0,
    financial_score: 0,
    final_score: score,
    match_reason: 'dense',
    fused_score: score,
  };
}

const REFUSE = { decision: 'refuse', basis: 'similarity_floor', reason: 'below_similarity_floor' } as unknown as RefusalRecord;

function input(overrides: Partial<MissLogInput> = {}): MissLogInput {
  return {
    enabled: true,
    profile: 'chat',
    scope,
    query: `where is termalpha, mail ${FAKE_EMAIL} or call ${FAKE_PHONE}`,
    queryLanguage: CODES[0]!,
    status: 'empty',
    reason: 'no_candidates',
    refusal: null,
    candidates: [],
    terminology: { enabled: true, version: 's3.w2' },
    retrievalConfigHash: HASH,
    ...overrides,
  };
}

function misses(calls: Call[]): Call[] {
  return calls.filter((call) => call.fn === 'rag_term_record_miss');
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shouldRecordMiss (D-25)', () => {
  it('records empty, refused and degraded-without-candidates requests of chat, embed and voice only', () => {
    expect(shouldRecordMiss(input())).toBe(true);
    expect(shouldRecordMiss(input({ enabled: false }))).toBe(false);
    expect(shouldRecordMiss(input({ status: 'ok', reason: 'ok', candidates: [candidate(0.9)] }))).toBe(false);
    expect(shouldRecordMiss(input({ profile: 'eval' }))).toBe(false);
    expect(shouldRecordMiss(input({ profile: 'media' }))).toBe(false);
    expect(shouldRecordMiss(input({ profile: 'embed' }))).toBe(true);
    expect(shouldRecordMiss(input({ profile: 'voice' }))).toBe(true);
    expect(shouldRecordMiss(input({ status: 'ok', refusal: REFUSE }))).toBe(true);
    expect(shouldRecordMiss(input({ status: 'degraded', candidates: [candidate(0.4)] }))).toBe(false);
    expect(shouldRecordMiss(input({ status: 'degraded', candidates: [] }))).toBe(true);
    expect(shouldRecordMiss(input({ status: 'error' }))).toBe(false);
    expect(shouldRecordMiss(input({ scope: null }))).toBe(false);
  });
});

describe('recordMiss', () => {
  it('switch off: no RPC call', async () => {
    const { client, calls } = recordingClient();
    await recordMiss(input({ enabled: false }), { client });
    expect(calls).toHaveLength(0);
  });

  it('status empty, profile chat: one call with the masked query, the dictionary version and the config hash', async () => {
    const { client, calls } = recordingClient();
    await recordMiss(input({ scoredCandidates: [candidate(0.2), candidate(0.31)] }), { client });
    expect(misses(calls)).toHaveLength(1);
    const { args } = misses(calls)[0]!;
    expect(args.p_tenant_key).toBe(TENANT);
    const row = args.p_row as Record<string, unknown>;
    expect(row).toMatchObject({
      source: 'miss_log',
      language: CODES[0],
      status: 'empty',
      reason: 'no_candidates',
      dictionary_version: 's3.w2',
      retrieval_config_hash: HASH,
      profile: 'chat',
    });
    expect(row.top_score).toBeCloseTo(0.31);
    expect(row.query_masked).toBe('where is termalpha, mail [EMAIL] or call [PHONE]');
    expect(JSON.stringify(args)).not.toContain(FAKE_EMAIL);
    expect(JSON.stringify(args)).not.toContain('7946');
  });

  it('cuts the masked query to 500 characters', async () => {
    const { client, calls } = recordingClient();
    await recordMiss(input({ query: 'termalpha '.repeat(80) }), { client });
    expect(((misses(calls)[0]!.args.p_row as Record<string, unknown>).query_masked as string).length).toBe(500);
  });

  it('records nothing for ok, eval or degraded with candidates; records refuse and degraded with none', async () => {
    const cases: [Partial<MissLogInput>, number][] = [
      [{ status: 'ok', reason: 'ok', candidates: [candidate(0.9)] }, 0],
      [{ profile: 'eval' }, 0],
      [{ status: 'degraded', candidates: [candidate(0.5)] }, 0],
      [{ status: 'empty', refusal: REFUSE, reason: 'below_similarity_floor' }, 1],
      [{ status: 'degraded', candidates: [] }, 1],
    ];
    for (const [overrides, expected] of cases) {
      const { client, calls } = recordingClient();
      await recordMiss(input(overrides), { client });
      expect(misses(calls), JSON.stringify(overrides)).toHaveLength(expected);
    }
  });

  it('dictionary_version is null when the terminology stage was skipped or disabled', async () => {
    for (const terminology of [{ enabled: true, version: null } as const, { enabled: false } as const, undefined]) {
      const { client, calls } = recordingClient();
      await recordMiss(input({ terminology }), { client });
      expect((misses(calls)[0]!.args.p_row as Record<string, unknown>).dictionary_version).toBeNull();
    }
  });

  it('a hanging write is aborted at 500 ms and logs one warning without the query', async () => {
    vi.useFakeTimers();
    for (const ignoreAbort of [false, true]) {
      vi.mocked(console.warn).mockClear();
      const { client, calls } = recordingClient({ hang: true, ignoreAbort });
      let settled = false;
      const pending = recordMiss(input(), { client }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(MISS_LOG_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(misses(calls)[0]!.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
      expect(misses(calls)[0]!.signal?.aborted).toBe(true);
      const warns = vi.mocked(console.warn).mock.calls;
      expect(warns).toHaveLength(1);
      expect(String(warns[0]![0])).toBe('[RAG Terminology] miss log write failed');
      expect(JSON.stringify(warns)).not.toContain('termalpha');
    }
    expect(MISS_LOG_TIMEOUT_MS).toBe(500);
  });

  it('a failing write never rejects and logs without the query', async () => {
    const { client } = recordingClient({ error: true });
    await expect(recordMiss(input(), { client })).resolves.toBeUndefined();
    const throwing: RpcClient = {
      rpc() {
        throw new Error('client exploded');
      },
    };
    await expect(recordMiss(input(), { client: throwing })).resolves.toBeUndefined();
    const warns = vi.mocked(console.warn).mock.calls;
    expect(warns).toHaveLength(2);
    expect(warns.every((call) => call[0] === '[RAG Terminology] miss log write failed')).toBe(true);
    expect(JSON.stringify(warns)).not.toContain('termalpha');
    expect(JSON.stringify(warns)).not.toContain(FAKE_EMAIL);
  });
});

describe('the v2 finish path records misses (D-25, D-36)', () => {
  let rpc: ReturnType<typeof recordingClient>;
  let dense: ReturnType<typeof hit>[] = [];

  function install(env: Record<string, string>, options: { hang?: boolean } = {}): void {
    resetActiveChunkingProfilesForTests();
    rpc = recordingClient(options);
    const base = fakeAssemblyAdmin();
    installDeps({
      adminClient: () => {
        const admin = base();
        return new Proxy(admin as object, { get: (target, key) => (key === 'rpc' ? rpc.client.rpc.bind(rpc.client) : Reflect.get(target, key)) }) as never;
      },
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', ...env }),
    });
    const backend: RetrievalBackend = {
      id: 'pgvector',
      search: async () => ({ dense, lexical: [] }),
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
    setRetrievalBackendForTests(backend);
  }

  async function retrieve(profile: 'chat' | 'eval' | 'voice' = 'chat') {
    await verifyV2Startup();
    return runRetrieval({ scope, query: `neutral sample question ${FAKE_EMAIL}`, profile, options: {}, signal: new AbortController().signal });
  }

  const saved = Object.fromEntries(Object.keys(LANGUAGES).map((name) => [name, process.env[name]]));

  beforeEach(() => {
    Object.assign(process.env, LANGUAGES);
    uninstallDeps();
    resetRagConfigForTests();
    resetV2StartupForTests();
    dense = [];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    uninstallDeps();
    resetRetrievalBackendForTests();
  });

  it('switch off: an empty request records nothing', async () => {
    install({ RAG_TERMINOLOGY_MINING: 'false' });
    const result = await retrieve();
    expect(result.status).toBe('empty');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(misses(rpc.calls)).toHaveLength(0);
  });

  it('switch on: an empty chat request records one masked miss with the result hash; eval and ok record nothing', async () => {
    install({ RAG_TERMINOLOGY_MINING: 'true' });
    const result = await retrieve();
    expect(result.status).toBe('empty');
    await vi.waitFor(() => expect(misses(rpc.calls)).toHaveLength(1));
    const { args } = misses(rpc.calls)[0]!;
    expect(args.p_tenant_key).toBe(TENANT);
    expect(args.p_row).toMatchObject({ profile: 'chat', status: 'empty', retrieval_config_hash: result.retrievalConfigHash, dictionary_version: null });
    expect(JSON.stringify(args)).not.toContain(FAKE_EMAIL);

    install({ RAG_TERMINOLOGY_MINING: 'true' });
    await retrieve('eval');
    dense = [hit('a', { rank: 1, similarity: 0.95, documentId: 'doc-a' })];
    const ok = await retrieve();
    expect(ok.status).toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(misses(rpc.calls)).toHaveLength(0);
  });

  it('the response never waits on a hanging write', async () => {
    install({ RAG_TERMINOLOGY_MINING: 'true' }, { hang: true });
    const started = Date.now();
    const result = await retrieve();
    expect(result.status).toBe('empty');
    expect(misses(rpc.calls)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(MISS_LOG_TIMEOUT_MS);
  });
});
