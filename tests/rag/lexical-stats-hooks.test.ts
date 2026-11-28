import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { RagConfig } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { dryRunRelex, runRelex } from '@/lib/rag/ingest/relex/run';
import { publishStage } from '@/lib/rag/ingest/stages/publish';
import type { StageContext } from '@/lib/rag/ingest/types';
import type { PublishResult } from '@/lib/rag/ingest/writer';
import { LEXICAL_WRITE_TIMEOUT_MS, afterDupClusterWrite, afterLexicalWrite, resetLexicalWriteLogForTests } from '@/lib/rag/lexical/stats-hooks';
import { SCOPE_A } from './cache/fixtures';

const KEY_A = 'u:00000000-0000-4000-8000-0000000000a1';
const KEY_B = 'u:00000000-0000-4000-8000-0000000000b2';
const DOC = '00000000-0000-4000-8000-00000000d201';
const LINEAGE = '00000000-0000-4000-8000-00000000c201';

type Answer = RpcResponse | Error | 'hang';
type Call = { fn: string; args: Record<string, unknown> };

const STATS_RPCS = new Set(['rag_lexstats_enable', 'rag_lexstats_rebuild', 'rag_lexstats_compact', 'rag_lexstats_compact_all', 'rag_lexstats_status', 'rag_lexstats_check']);

function recordingDb(answers: Record<string, (args: Record<string, unknown>) => Answer> = {}): { db: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const answer = answers[fn]?.(args) ?? { data: null, error: null };
      const settled: Promise<RpcResponse> =
        answer === 'hang' ? new Promise<RpcResponse>(() => undefined) : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => settled.then(onFulfilled, onRejected) };
      return request;
    },
  };
  return { db, calls };
}

const statsCalls = (calls: Call[]) => calls.filter((call) => STATS_RPCS.has(call.fn));
const fns = (calls: Call[]) => statsCalls(calls).map((call) => call.fn);

function configOf(mode: 'bm25' | 'ts_rank_cd'): Pick<RagConfig, 'v2'> {
  return { v2: { lexicalScoring: { mode, k1: 1.2, b: 0.75 } } } as unknown as Pick<RagConfig, 'v2'>;
}

const enableAnswer = (state: 'building' | 'ready') => ({ rag_lexstats_enable: () => ({ data: state, error: null }) });

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetLexicalWriteLogForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetRagDepsForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const lexicalLines = () => warn.mock.calls.map((args: unknown[]) => args.map(String).join(' ')).filter((line: string) => line.includes('[Lexical Stats]'));

describe('afterLexicalWrite', () => {
  it('waits at most five seconds by default', () => {
    expect(LEXICAL_WRITE_TIMEOUT_MS).toBe(5_000);
  });

  it('makes no call with ts_rank_cd', async () => {
    const { db, calls } = recordingDb();
    await afterLexicalWrite({ db: () => db, config: configOf('ts_rank_cd') }, KEY_A);
    expect(calls).toEqual([]);
  });

  it('a tenant without statistics: enable, rebuild, compact in that order, with the tenant key and the default batch', async () => {
    const { db, calls } = recordingDb(enableAnswer('building'));
    await afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_A);
    expect(calls).toEqual([
      { fn: 'rag_lexstats_enable', args: { p_tenant_key: KEY_A } },
      { fn: 'rag_lexstats_rebuild', args: { p_tenant_key: KEY_A } },
      { fn: 'rag_lexstats_compact', args: { p_tenant_key: KEY_A, p_max_rows: 5000 } },
    ]);
  });

  it('also reads the one-row scalar answer keyed by the function name', async () => {
    const { db, calls } = recordingDb({ rag_lexstats_enable: () => ({ data: [{ rag_lexstats_enable: 'building' }], error: null }) });
    await afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_A);
    expect(fns(calls)).toEqual(['rag_lexstats_enable', 'rag_lexstats_rebuild', 'rag_lexstats_compact']);
    expect(lexicalLines()).toEqual([]);
  });

  it('a ready tenant: no rebuild, one compaction', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    await afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_A);
    expect(fns(calls)).toEqual(['rag_lexstats_enable', 'rag_lexstats_compact']);
  });

  it('an RPC error resolves, logs once per tenant hash with the rpc name and code, and never the key', async () => {
    const { db } = recordingDb({ ...enableAnswer('ready'), rag_lexstats_compact: () => ({ data: null, error: { code: '42883', message: 'secret detail' } }) });
    await expect(afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_A)).resolves.toBeUndefined();
    await afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_A);
    const lines = lexicalLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(hashOf(KEY_A));
    expect(lines[0]).toContain('rag_lexstats_compact');
    expect(lines[0]).toContain('42883');
    expect(lines[0]).not.toContain(KEY_A);
    expect(lines[0]).not.toContain('secret detail');

    await afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_B);
    expect(lexicalLines()).toHaveLength(2);
    expect(lexicalLines()[1]).toContain(hashOf(KEY_B));
  });

  it('a rejected call resolves and logs the rpc name', async () => {
    const { db } = recordingDb({ rag_lexstats_enable: () => new Error('connection reset') });
    await expect(afterLexicalWrite({ db: () => db, config: configOf('bm25') }, KEY_A)).resolves.toBeUndefined();
    expect(lexicalLines()).toHaveLength(1);
    expect(lexicalLines()[0]).toContain('rag_lexstats_enable');
    expect(lexicalLines()[0]).not.toContain('connection reset');
  });

  it('a call that never resolves gives up after the timeout and logs it as a timeout', async () => {
    const { db } = recordingDb({ ...enableAnswer('building'), rag_lexstats_rebuild: () => 'hang' });
    const started = Date.now();
    await afterLexicalWrite({ db: () => db, config: configOf('bm25'), timeoutMs: 40 }, KEY_A);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lexicalLines()).toHaveLength(1);
    expect(lexicalLines()[0]).toContain('rag_lexstats_rebuild');
    expect(lexicalLines()[0]).toContain('timeout');
  });

  it('no admin client, or a configuration that cannot be read, makes no call and does not throw', async () => {
    await expect(afterLexicalWrite({ db: () => null, config: configOf('bm25') }, KEY_A)).resolves.toBeUndefined();
    const { db, calls } = recordingDb();
    const broken = { get v2(): never { throw new Error('bad config'); } } as unknown as Pick<RagConfig, 'v2'>;
    await expect(afterLexicalWrite({ db: () => db, config: broken }, KEY_A)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('without a config it reads the app configuration (bm25 needs v2 and lexical search)', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_SCORING: 'bm25' }) });
    await afterLexicalWrite({ db: () => db }, KEY_A);
    expect(fns(calls)).toEqual(['rag_lexstats_enable', 'rag_lexstats_compact']);
    calls.length = 0;
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await afterLexicalWrite({ db: () => db }, KEY_A);
    expect(calls).toEqual([]);
  });
});

const PUBLISHED: PublishResult = { outcome: 'published', documentId: DOC, version: 2, supersededDocumentId: null };

function publishContext(db: RpcClient, outcome: PublishResult = PUBLISHED): StageContext {
  return {
    input: { scope: SCOPE_A, signal: new AbortController().signal } as unknown as StageContext['input'],
    config: loadIngestConfig({}),
    deps: { db: () => db, now: () => 0 } as unknown as StageContext['deps'],
    identity: { tenantKey: KEY_A, filename: 'notes.md', fileSha256: 'a'.repeat(64), docType: 'general', docTypeOrigin: 'picked', profile: getProcessingProfile('general'), bytes: null },
    writer: { setFields: async () => undefined, publish: async () => outcome } as unknown as StageContext['writer'],
    document: { id: DOC, version: 2, lineageId: LINEAGE, resumed: false },
    parserUsed: 'text',
    work: { chunksWritten: 3 } as StageContext['work'],
    state: { embeddingTargets: [] },
    warnings: [],
  } as unknown as StageContext;
}

const BM25_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_SCORING: 'bm25' };

describe('afterDupClusterWrite (04.4-17, D-48, D-49)', () => {
  const withDf = (mode: 'bm25' | 'ts_rank_cd', dfMode: 'raw' | 'cluster'): Pick<RagConfig, 'v2'> =>
    ({ v2: { lexicalScoring: { mode, k1: 1.2, b: 0.75, dfMode } } }) as unknown as Pick<RagConfig, 'v2'>;

  it.each([
    ['ts_rank_cd', 'raw'],
    ['bm25', 'raw'],
  ] as const)('%s with DF mode %s: no call', async (mode, dfMode) => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    expect(await afterDupClusterWrite({ db: () => db, config: withDf(mode, dfMode) }, KEY_A)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('bm25 with DF mode cluster: enable and one compaction for the tenant, as after a publish', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    expect(await afterDupClusterWrite({ db: () => db, config: withDf('bm25', 'cluster') }, KEY_A)).toBe(true);
    expect(fns(calls)).toEqual(['rag_lexstats_enable', 'rag_lexstats_compact']);
    expect(statsCalls(calls).every((call) => call.args.p_tenant_key === KEY_A)).toBe(true);
  });

  it('a failing compaction resolves and logs the rpc name and code once, never the key', async () => {
    const { db } = recordingDb({ ...enableAnswer('ready'), rag_lexstats_compact: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) });
    await expect(afterDupClusterWrite({ db: () => db, config: withDf('bm25', 'cluster') }, KEY_A)).resolves.toBe(true);
    expect(lexicalLines()).toEqual([expect.stringContaining(`${hashOf(KEY_A)} rag_lexstats_compact failed (XX000)`)]);
    expect(lexicalLines().join('\n')).not.toContain(KEY_A);
  });
});

describe('publish stage and the lexical statistics', () => {
  it('bm25 with DF mode cluster: publish needs no new call (compaction reconciles the cluster markers)', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    setRagDepsForTests({ ragEnv: () => ({ ...BM25_ENV, RAG_DUP_CLUSTERS: 'true', RAG_LEXICAL_DF_MODE: 'cluster' }) });
    await publishStage.run(publishContext(db));
    expect(fns(calls)).toEqual(['rag_lexstats_enable', 'rag_lexstats_compact']);
  });

  it('ts_rank_cd: publish makes no statistics call', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    const outcome = await publishStage.run(publishContext(db));
    expect(outcome.kind).toBe('done');
    expect(statsCalls(calls)).toEqual([]);
  });

  it('bm25: a published version keeps the tenant statistics current before the stage returns', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    setRagDepsForTests({ ragEnv: () => BM25_ENV });
    const without = await publishStage.run(publishContext(recordingDb().db));
    setRagDepsForTests({ ragEnv: () => BM25_ENV });
    const outcome = await publishStage.run(publishContext(db));
    expect(fns(calls)).toEqual(['rag_lexstats_enable', 'rag_lexstats_compact']);
    expect(statsCalls(calls).every((call) => call.args.p_tenant_key === KEY_A)).toBe(true);
    expect(outcome).toEqual(without);
  });

  it('bm25: a failing statistics call leaves the publish result unchanged', async () => {
    const { db } = recordingDb({ rag_lexstats_enable: () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } }) });
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    const baseline = await publishStage.run(publishContext(recordingDb().db));
    setRagDepsForTests({ ragEnv: () => BM25_ENV });
    const outcome = await publishStage.run(publishContext(db));
    expect(outcome).toEqual(baseline);
    expect(lexicalLines()).toHaveLength(1);
  });

  it('bm25: a statistics call that hangs delays the publish result by the timeout at most', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { db } = recordingDb({ rag_lexstats_enable: () => 'hang' });
    setRagDepsForTests({ ragEnv: () => BM25_ENV });
    let settled = false;
    const running = publishStage.run(publishContext(db)).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(LEXICAL_WRITE_TIMEOUT_MS + 50);
    expect(settled).toBe(true);
    const outcome = await running;
    expect(outcome.kind).toBe('done');
    expect(lexicalLines()).toHaveLength(1);
  });

  it('bm25: a version held for its batch is not current, so no statistics call follows', async () => {
    const { db, calls } = recordingDb(enableAnswer('ready'));
    setRagDepsForTests({ ragEnv: () => BM25_ENV });
    await publishStage.run(publishContext(db, { ...PUBLISHED, outcome: 'held' }));
    expect(statsCalls(calls)).toEqual([]);
  });
});

const ROW = (id: string, tenantKey: string) => ({
  id,
  tenant_key: tenantKey,
  content: 'Synthetic note w1 w2',
  section_path: [],
  chunk_kind: null,
  metadata: {},
  language: 'en',
  document_filename: 'synthetic.md',
});

function relexDb() {
  return recordingDb({
    ...enableAnswer('ready'),
    rag_relex_candidates: (args) => ({
      data: args.p_after === null ? [ROW('00000000-0000-4000-8000-000000000301', KEY_B), ROW('00000000-0000-4000-8000-000000000302', KEY_A), ROW('00000000-0000-4000-8000-000000000303', KEY_B)] : [],
      error: null,
    }),
    rag_relex_batch: () => ({ data: [{ rag_relex_batch: 3 }], error: null }),
  });
}

describe('relex run and the lexical statistics', () => {
  it('bm25: one enable and compaction per tenant the run touched, after the last batch', async () => {
    const { db, calls } = relexDb();
    const report = await runRelex({ db, config: configOf('bm25'), batchSize: 2 });
    expect(report.updated).toBeGreaterThan(0);
    const lastBatch = calls.map((call) => call.fn).lastIndexOf('rag_relex_batch');
    const firstStats = calls.findIndex((call) => STATS_RPCS.has(call.fn));
    expect(firstStats).toBeGreaterThan(lastBatch);
    expect(statsCalls(calls)).toEqual([
      { fn: 'rag_lexstats_enable', args: { p_tenant_key: KEY_A } },
      { fn: 'rag_lexstats_compact', args: { p_tenant_key: KEY_A, p_max_rows: 5000 } },
      { fn: 'rag_lexstats_enable', args: { p_tenant_key: KEY_B } },
      { fn: 'rag_lexstats_compact', args: { p_tenant_key: KEY_B, p_max_rows: 5000 } },
    ]);
  });

  it('ts_rank_cd, or no configuration: no statistics call', async () => {
    for (const config of [configOf('ts_rank_cd'), undefined]) {
      const { db, calls } = relexDb();
      await runRelex({ db, ...(config ? { config } : {}) });
      expect(statsCalls(calls)).toEqual([]);
    }
  });

  it('a dry run calls nothing', async () => {
    const { db, calls } = relexDb();
    await dryRunRelex({ db, config: configOf('bm25') });
    expect(statsCalls(calls)).toEqual([]);
  });

  it('a failing statistics call keeps the relex report', async () => {
    const failing = recordingDb({
      rag_lexstats_enable: () => new Error('down'),
      rag_relex_candidates: (args) => ({ data: args.p_after === null ? [ROW('00000000-0000-4000-8000-000000000301', KEY_A)] : [], error: null }),
      rag_relex_batch: () => ({ data: [{ rag_relex_batch: 1 }], error: null }),
    });
    const report = await runRelex({ db: failing.db, config: configOf('bm25') });
    expect(report).toEqual({ updated: 1, batches: 1, tenants: { [KEY_A]: 1 } });
  });
});
