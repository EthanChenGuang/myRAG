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

export interface SupabaseFakeStore {
  documents: FakeDocumentRow[];
  document_chunks: FakeChunkRow[];
  [table: string]: object[];
}

export function createSupabaseFake() {
  const store: SupabaseFakeStore = { documents: [], document_chunks: [] };

  function from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const run = (single: boolean) => {
      const rows = (store[table] ?? []).filter((row) =>
        filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value),
      );
      if (single) {
        return rows.length > 0
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
      }
      return { data: rows, error: null };
    };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'ilike', 'like', 'limit', 'order', 'in', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not', 'or', 'range']) {
      builder[method] = () => builder;
    }
    builder.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    };
    builder.single = async () => run(true);
    builder.maybeSingle = async () => run(true);
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(run(false)).then(resolve, reject);
    return builder;
  }

  const client = {
    from: vi.fn(from),
    rpc: vi.fn(async () => ({ data: [], error: null })),
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
