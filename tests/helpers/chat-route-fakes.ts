import { vi } from 'vitest';
import { NextRequest } from 'next/server';

export const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001';

export interface FakeDocumentRow {
  id: string;
  filename: string;
  created_at?: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FakeChunkRow {
  id: string;
  document_id?: string;
  content?: string;
  metadata?: Record<string, unknown> | null;
}

export interface SupabaseCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface SupabaseRpcCall {
  rpc: string;
  args: unknown;
}

export interface SupabaseFakeStore {
  documents: FakeDocumentRow[];
  document_chunks: FakeChunkRow[];
  calls: Array<SupabaseCall | SupabaseRpcCall>;
  rpcCalls: SupabaseRpcCall[];
  reset(): void;
  [table: string]: object[] | (() => void);
}

function readColumn(row: Record<string, unknown>, column: string): unknown {
  const [head, ...path] = column.split('->>');
  let value: unknown = row[head];
  for (const key of path) {
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}

function likeToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${source}$`, 'is');
}

export function createSupabaseFake() {
  const calls: Array<SupabaseCall | SupabaseRpcCall> = [];
  const rpcCalls: SupabaseRpcCall[] = [];
  const store: SupabaseFakeStore = {
    documents: [],
    document_chunks: [],
    calls,
    rpcCalls,
    reset() {
      calls.length = 0;
      rpcCalls.length = 0;
    },
  };

  function from(table: string) {
    type Row = Record<string, unknown>;
    const predicates: Array<(row: Row) => boolean> = [];
    let limit: number | undefined;
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args });
    };
    const rowsFor = (): Row[] => {
      const source = store[table];
      const all = (Array.isArray(source) ? source : []) as Row[];
      const matched = all.filter((row) => predicates.every((predicate) => predicate(row)));
      return limit === undefined ? matched : matched.slice(0, limit);
    };
    const run = (single: boolean, nullWhenEmpty = false) => {
      const rows = rowsFor();
      if (single) {
        if (rows.length > 0) return { data: rows[0], error: null };
        return nullWhenEmpty ? { data: null, error: null } : { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
      }
      return { data: rows, error: null };
    };
    const builder: Record<string, any> = {};
    for (const method of ['select', 'like', 'order', 'neq', 'gt', 'gte', 'lt', 'lte', 'not', 'or', 'range', 'abortSignal']) {
      builder[method] = (...args: unknown[]) => {
        record(method, args);
        return builder;
      };
    }
    builder.eq = (column: string, value: unknown) => {
      record('eq', [column, value]);
      predicates.push((row) => readColumn(row, column) === value);
      return builder;
    };
    builder.in = (column: string, values: unknown[]) => {
      record('in', [column, values]);
      predicates.push((row) => values.includes(readColumn(row, column)));
      return builder;
    };
    builder.is = (column: string, value: unknown) => {
      record('is', [column, value]);
      predicates.push((row) => {
        const actual = readColumn(row, column);
        return value === null ? actual === null || actual === undefined : actual === value;
      });
      return builder;
    };
    builder.ilike = (column: string, pattern: string) => {
      record('ilike', [column, pattern]);
      const matcher = likeToRegExp(pattern);
      predicates.push((row) => {
        const actual = readColumn(row, column);
        return typeof actual === 'string' && matcher.test(actual);
      });
      return builder;
    };
    builder.upsert = (row: Row, options?: { onConflict?: string }) => {
      record('upsert', [row, options]);
      const source = store[table];
      if (Array.isArray(source)) {
        const keys = (options?.onConflict ?? 'id').split(',');
        const exists = (source as Row[]).some((existing) => keys.every((key) => existing[key] === row[key]));
        if (!exists) (source as Row[]).push(row);
      }
      return builder;
    };
    builder.limit = (count: number) => {
      record('limit', [count]);
      limit = count;
      return builder;
    };
    builder.single = async () => {
      record('single', []);
      return run(true);
    };
    builder.maybeSingle = async () => {
      record('maybeSingle', []);
      return run(true, true);
    };
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run(false)).then(resolve, reject);
    return builder;
  }

  const client = {
    from: vi.fn(from),
    rpc: vi.fn(async (name: string, args?: unknown) => {
      const entry = { rpc: name, args };
      calls.push(entry);
      rpcCalls.push(entry);
      return { data: [], error: null };
    }),
  };

  return { client, store };
}

export function createSsrClientFake(userId: string = FAKE_USER_ID) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })),
    },
  };
}

export interface StreamTextCaptureOptions {
  deltas?: string[];
}

export function createStreamTextCapture(options: StreamTextCaptureOptions = {}) {
  const state = { deltas: options.deltas ?? ['ok'] };
  const calls: Array<Record<string, any>> = [];

  const streamText = vi.fn(async (params: Record<string, any>) => {
    calls.push(params);
    return {
      toUIMessageStream: ({ sendStart }: { sendStart?: boolean } = {}) =>
        new ReadableStream({
          start(controller) {
            if (sendStart !== false) controller.enqueue({ type: 'start' });
            controller.enqueue({ type: 'text-start', id: 'fake-text' });
            for (const delta of state.deltas) {
              controller.enqueue({ type: 'text-delta', id: 'fake-text', delta });
            }
            controller.enqueue({ type: 'text-end', id: 'fake-text' });
            controller.enqueue({ type: 'finish' });
            controller.close();
          },
        }),
    };
  });

  return {
    streamText,
    calls,
    setDeltas(deltas: string[]) {
      state.deltas = deltas;
    },
    reset() {
      streamText.mockClear();
      calls.length = 0;
      state.deltas = options.deltas ?? ['ok'];
    },
  };
}

export function createExaFake() {
  const searchAndContents = vi.fn<(query: string, options?: Record<string, unknown>) => Promise<{ results: Array<Record<string, unknown>> }>>(
    async () => ({ results: [] }),
  );
  const constructed: string[] = [];

  class FakeExa {
    searchAndContents = searchAndContents;
    constructor(apiKey: string) {
      constructed.push(apiKey);
    }
  }

  return {
    Exa: FakeExa,
    searchAndContents,
    constructed,
    reset() {
      searchAndContents.mockReset();
      searchAndContents.mockResolvedValue({ results: [] });
      constructed.length = 0;
    },
  };
}

export function createChatRouteHarness() {
  return {
    supabase: createSupabaseFake(),
    ssr: createSsrClientFake(),
    capture: createStreamTextCapture(),
    exa: createExaFake(),
    retrieval: vi.fn(),
  };
}

export type ChatRouteHarness = ReturnType<typeof createChatRouteHarness>;

function retrievalRows(fn: string, result: ReturnType<typeof retrievalWith> | undefined): unknown[] {
  return (result?.chunks ?? []).map((chunk) => {
    const row = chunk as Record<string, unknown>;
    return fn === 'match_documents_by_workspace'
      ? { id: row.chunk_id, document_id: row.document_id, content: row.content, similarity: row.similarity, metadata: row.metadata }
      : { chunk_id: row.chunk_id, document_id: row.document_id, content: row.content, similarity: row.similarity, metadata: row.metadata };
  });
}

/**
 * Routes the pipeline's retrieval through the fake: the vector RPC on the anonymous client calls `h.retrieval`
 * (which returns the legacy `{ chunks }` shape), and the assembly lookups read the fake admin client.
 * Call after vi.resetModules() and before importing the route, so the route shares this deps module.
 */
export async function installChatPipeline(h: ChatRouteHarness): Promise<void> {
  const deps = await import('@/lib/rag/deps');
  const config = await import('@/lib/rag/config');
  config.resetRagConfigForTests();
  deps.resetRagDepsForTests();
  deps.setRagDepsForTests({
    embedder: async () => [0.1, 0.2, 0.3],
    adminClient: () => h.supabase.client as never,
    anonClient: () => ({
      rpc(fn: string, args: Record<string, unknown>) {
        const request = {
          abortSignal: () => request,
          then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve()
              .then(async () => {
                const result = (await h.retrieval(fn, args)) as ReturnType<typeof retrievalWith> | undefined;
                return { data: retrievalRows(fn, result), error: null };
              })
              .then(onFulfilled, onRejected),
        };
        return request as never;
      },
    }),
  });
}

export function emptyRetrieval() {
  return {
    chunks: [],
    queryContext: {
      isTemporalQuery: false,
      isFinancialQuery: false,
      isSpecificDataQuery: false,
      requiredPrecision: 'standard',
      suggestedThreshold: 0.3,
      reasoningText: 'fake',
      financialMetrics: [],
    },
    retrievalStrategy: 'fake',
    totalFound: 0,
  };
}

export function retrievalWith(chunks: Array<Record<string, unknown>>) {
  return { ...emptyRetrieval(), chunks, totalFound: chunks.length };
}

export async function readSse(response: Response): Promise<string> {
  return response.text();
}

export function chatRequest(body: Record<string, unknown>, url = 'http://localhost/api/chat') {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
