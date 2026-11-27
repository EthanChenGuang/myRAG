import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { RagEnvInput } from '@/lib/rag/config';
import type { RagDeps } from '@/lib/rag/deps';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile, RetrievalResult, RunRetrievalInput } from '@/lib/rag/types';
import { SEMANTIC_QUERY, fakeEmbedder, installDeps, rows, uninstallDeps, type FakeRow } from './helpers/pipeline-fakes';

const RECHECK_RPC = 'rag_source_recheck';
const EXACT_RPC = 'rag_exact_id_documents';
const scope = mintScope('single', null, null);

interface RoutedOptions {
  vector?: FakeRow[];
  stale?: readonly string[];
  recheckError?: { message: string; code?: string };
  recheckDelayMs?: number;
  exact?: Array<Record<string, unknown>>;
}

interface RoutedCall {
  fn: string;
  args: Record<string, unknown>;
}

function routedRpc(options: RoutedOptions) {
  const calls: RoutedCall[] = [];
  const stale = new Set(options.stale ?? []);
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      let signal: AbortSignal | undefined;
      const respond = (): RpcResponse => {
        if (fn === RECHECK_RPC) {
          if (options.recheckError) return { data: null, error: options.recheckError };
          const ids = (args?.p_chunk_ids as string[] | undefined) ?? [];
          return { data: ids.filter((id) => !stale.has(id)).map((chunk_id) => ({ chunk_id })), error: null };
        }
        if (fn === EXACT_RPC) return { data: options.exact ?? [], error: null };
        return { data: options.vector ?? [], error: null };
      };
      const request: RpcRequest = {
        abortSignal(next) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
          const delay = fn === RECHECK_RPC ? (options.recheckDelayMs ?? 0) : 0;
          const settled = new Promise<RpcResponse>((resolve) => {
            const timer = setTimeout(() => resolve(respond()), delay);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve({ data: null, error: { message: 'aborted' } });
              },
              { once: true },
            );
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return {
    client,
    calls,
    recheckCalls: () => calls.filter((call) => call.fn === RECHECK_RPC),
    otherCalls: () => calls.filter((call) => call.fn !== RECHECK_RPC),
  };
}

type PathName = 'chat' | 'voice' | 'media' | 'overview';

const PATH_ENV: Record<PathName, RagEnvInput> = {
  chat: {},
  // The keyword fallback reads tables the fake admin does not serve; it is disabled on both sides of every comparison.
  voice: { RAG_DISABLED_STAGES: 'voice_keyword_fallback' },
  media: {},
  overview: {},
};

const OFF_STAGES: Record<PathName, string[]> = {
  chat: ['analyze', 'embed', 'search', 'legacy_rank', 'post_filter', 'assemble'],
  voice: ['embed', 'search', 'voice_keyword_fallback', 'local_rerank', 'assemble'],
  media: ['embed', 'search', 'assemble'],
  overview: ['embed', 'search', 'assemble'],
};

const ON_STAGES: Record<PathName, string[]> = {
  chat: ['analyze', 'embed', 'search', 'source_recheck', 'legacy_rank', 'post_filter', 'assemble'],
  voice: ['embed', 'search', 'voice_keyword_fallback', 'source_recheck', 'local_rerank', 'assemble'],
  media: ['embed', 'search', 'source_recheck', 'assemble'],
  overview: ['embed', 'search', 'source_recheck', 'assemble'],
};

/** Document and chunk rows for every id asked for; unlike the shared fake it also takes the overview's .eq filters. */
function assemblyAdmin(): RagDeps['adminClient'] {
  const client = {
    from(table: string) {
      let ids: string[] = [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        in(_column: string, values: string[]) {
          ids = values;
          return builder;
        },
        abortSignal: () => builder,
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          const data =
            table === 'documents'
              ? ids.map((id) => ({ id, filename: `${id}.md`, created_at: null, content: null, metadata: null }))
              : ids.map((id) => ({ id, metadata: null }));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return () => client as never;
}

function install(path: PathName, options: RoutedOptions, env: RagEnvInput) {
  const rpc = routedRpc(options);
  installDeps({
    searchRpc: rpc.client,
    adminClient: assemblyAdmin(),
    embedder: fakeEmbedder().embedder,
    ragEnv: () => ({ ...PATH_ENV[path], ...env }),
  });
  return rpc;
}

function run(path: PathName, query = SEMANTIC_QUERY): Promise<RetrievalResult> {
  const profile: Profile = path === 'voice' ? 'voice' : path === 'media' ? 'media' : 'chat';
  const input: RunRetrievalInput = { scope, query, profile, signal: new AbortController().signal };
  if (path === 'overview') input.options = { generalOverview: true };
  return runRetrieval(input);
}

/** The chunk ids that came out of each path: what was ranked and assembled. */
function outputIds(path: PathName, result: RetrievalResult): string[] {
  if (path === 'voice') return (result.voice?.results ?? []).map((row) => String((row as { chunk_id?: string }).chunk_id));
  return result.candidates.map((item) => item.chunk_id);
}

const stageNames = (result: RetrievalResult) => result.stages.map((stage) => stage.name);
const stage = (result: RetrievalResult, name: string) => result.stages.find((record) => record.name === name);

const ON = { RAG_SOURCE_RECHECK: 'true' };
const PATHS: PathName[] = ['chat', 'voice', 'media', 'overview'];

beforeEach(() => {
  uninstallDeps();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('source_recheck on the legacy chat path (D-19, D-38, D-46)', () => {
  it('drops a stale candidate after search and before legacy_rank, records the counts and sets the marker', async () => {
    const rpc = install('chat', { vector: rows(3), stale: ['chunk-2'] }, ON);
    const result = await run('chat');
    expect(stageNames(result)).toEqual(ON_STAGES.chat);
    expect(stage(result, 'source_recheck')).toMatchObject({
      status: 'ok',
      candidates_in: 3,
      candidates_out: 2,
      counts: { stale_index_drop: 1, checked: 3 },
    });
    expect(stage(result, 'legacy_rank')).toMatchObject({ candidates_in: 2 });
    expect(outputIds('chat', result)).toEqual(['chunk-1', 'chunk-3']);
    expect(result.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
    expect(result.status).toBe('ok');
    expect(rpc.recheckCalls()).toHaveLength(1);
    expect(rpc.recheckCalls()[0]?.args).toEqual({ p_tenant_key: 's:default', p_chunk_ids: ['chunk-1', 'chunk-2', 'chunk-3'] });
  });

  it('rechecks the exact-id chunks too: the stage runs after the exact-id merge', async () => {
    const exact = [{ chunk_id: 'e1', document_id: 'doc-e1', content: 'exact body', metadata: null, matched_field: 'invoice_number' }];
    const rpc = install('chat', { vector: rows(2), exact, stale: ['e1'] }, { ...ON, RAG_EXACT_ID_LOOKUP: 'true' });
    const result = await run('chat', 'What is the total of invoice FT-2025-00417?');
    expect(stageNames(result)).toEqual(['analyze', 'embed', 'search', 'exact_id_lookup', 'source_recheck', 'legacy_rank', 'post_filter', 'assemble']);
    expect(rpc.recheckCalls()[0]?.args.p_chunk_ids).toEqual(['e1', 'chunk-1', 'chunk-2']);
    expect(outputIds('chat', result)).toEqual(['chunk-1', 'chunk-2']);
    expect(result.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
  });
});

describe('source_recheck on every legacy path', () => {
  for (const path of PATHS) {
    it(`${path}: switch on drops the stale candidate before ranking or assembly and sets the marker`, async () => {
      install(path, { vector: rows(3), stale: ['chunk-2'] }, ON);
      const result = await run(path);
      expect(stageNames(result)).toEqual(ON_STAGES[path]);
      expect(stage(result, 'source_recheck')).toMatchObject({ status: 'ok', counts: { stale_index_drop: 1, checked: 3 } });
      expect(outputIds(path, result)).not.toContain('chunk-2');
      expect(outputIds(path, result).length).toBeGreaterThan(0);
      expect(result.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
      expect(result.status).toBe('ok');
    });

    it(`${path}: switch off does not enter the stage, so stages, counts and output are as before`, async () => {
      const rpc = install(path, { vector: rows(3), stale: ['chunk-2'] }, {});
      const result = await run(path);
      expect(stageNames(result)).toEqual(OFF_STAGES[path]);
      expect(rpc.recheckCalls()).toEqual([]);
      expect(result.sourceRecheck).toBeUndefined();
      expect(outputIds(path, result)).toContain('chunk-2');
      expect(result.status).toBe('ok');
    });

    it(`${path}: a recheck RPC error degrades the result, keeps every candidate and sets no marker`, async () => {
      install(path, { vector: rows(3), stale: ['chunk-2'], recheckError: { message: 'boom', code: 'XX000' } }, ON);
      const result = await run(path);
      expect(result.status).toBe('degraded');
      expect(result.reason).toBe('source_recheck_failed');
      expect(stage(result, 'source_recheck')).toMatchObject({ status: 'skipped', reason: 'failed', detail: 'unchecked=3;error=XX000' });
      expect(outputIds(path, result)).toContain('chunk-2');
      expect(result.sourceRecheck).toBeUndefined();
    });
  }

  it('the switched-off stage list of every path equals a run with an unsupported switch value', async () => {
    for (const path of PATHS) {
      install(path, { vector: rows(3) }, {});
      const off = await run(path);
      uninstallDeps();
      install(path, { vector: rows(3) }, { RAG_SOURCE_RECHECK: 'yes' });
      const invalid = await run(path);
      uninstallDeps();
      expect(stageNames(invalid), path).toEqual(stageNames(off));
      expect(invalid.stages.map((record) => record.counts ?? null), path).toEqual(off.stages.map((record) => record.counts ?? null));
    }
  });

  it('a non-zero drop logs one [Document Search] line with counts only and sends no repair request', async () => {
    for (const path of PATHS) {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const rpc = install(path, { vector: rows(3), stale: ['chunk-2'] }, ON);
      await run(path);
      const lines = info.mock.calls.filter((call) => String(call[0]).startsWith('[Document Search]'));
      expect(lines, path).toEqual([['[Document Search] Source recheck dropped stale candidates', { dropped: 1, checked: 3 }]]);
      expect(rpc.recheckCalls(), path).toHaveLength(1);
      expect(rpc.otherCalls().every((call) => call.fn !== RECHECK_RPC && !/repair|reconcile|purge/.test(call.fn)), path).toBe(true);
      info.mockRestore();
      uninstallDeps();
    }
  });

  it('the voice stage runs under the voice timeout (300 ms) while chat keeps 1000 ms', async () => {
    install('voice', { vector: rows(3), recheckDelayMs: 500 }, ON);
    const voice = await run('voice');
    expect(stage(voice, 'source_recheck')).toMatchObject({ status: 'skipped', reason: 'timeout' });
    expect(voice.reason).toBe('source_recheck_timeout');
    expect(voice.sourceRecheck).toBeUndefined();
    uninstallDeps();

    install('chat', { vector: rows(3), recheckDelayMs: 500 }, ON);
    const chat = await run('chat');
    expect(stage(chat, 'source_recheck')).toMatchObject({ status: 'ok' });
    expect(chat.sourceRecheck).toEqual({ checked: 3, dropped: 0 });
  });
});
