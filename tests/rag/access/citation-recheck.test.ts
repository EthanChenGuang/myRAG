import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamText, type UIMessageChunk } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createCitationSession, type CitationFinishMetadata, type CitationSession, type ContextBlock } from '@/lib/rag';
import { env } from '@/lib/env';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3: Mock, convertArrayToReadableStream: toStream } = await import('ai/test');
  const state = {
    deltas: ['ok'] as string[],
    /** null: no recheck, as the real createCitationRecheck returns while RAG_DOC_ACCESS_GROUPS is off. */
    recheck: null as null | ((ids: readonly string[]) => Promise<ReadonlySet<string>>),
    asked: [] as string[][],
    events: [] as Array<Record<string, unknown>>,
  };
  const model = (modelId: string) =>
    new Mock({
      modelId,
      doStream: async () => ({
        stream: toStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          ...state.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      }),
    });
  return { state, model, exa: fakes.createExaFake(), ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } } };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => (modelId: string) => h.model(modelId) }));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag/access/visibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/access/visibility')>();
  return {
    ...actual,
    createCitationRecheck: () => {
      const fake = h.state.recheck;
      // Off (RAG_DOC_ACCESS_GROUPS unset): the real builder returns undefined; visibility.test.ts covers it with a minted scope.
      if (!fake) return undefined;
      return async (ids: readonly string[]) => {
        h.state.asked.push([...ids]);
        return fake(ids);
      };
    },
    scheduleSecurityEvent: (_scope: unknown, input: Record<string, unknown>) => {
      h.state.events.push(input);
    },
  };
});

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function blocks(): ContextBlock[] {
  return [1, 2].map((index) => ({
    documentId: `doc-${index}`,
    documentName: `note-${index}.txt`,
    documentVersion: 1,
    chunkIds: [`chunk-${index}`],
    page: null,
    sectionPath: null,
    title: `note-${index}.txt`,
    text: `Synthetic sample sentence ${index}.`,
    isImage: false,
    alias: `S${index}`,
  }));
}

function session(recheck?: (ids: readonly string[]) => Promise<ReadonlySet<string>>): CitationSession {
  const created = createCitationSession({
    capabilities: { citations: true },
    ragMode: 'strict',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    language: 'en',
    config: { citations: true },
    ...(recheck ? { recheck } : {}),
  });
  created.attach({ blocks: blocks() });
  return created;
}

async function run(citationSession: CitationSession, deltas: string[]) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      ]),
    }),
  });
  const result = streamText({ model, prompt: 'question', experimental_transform: citationSession.transforms(), onError: () => {} });
  let finishSeen: CitationFinishMetadata | undefined;
  const chunks: UIMessageChunk[] = [];
  const reader = result
    .toUIMessageStream({
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined;
        finishSeen = citationSession.finishMetadata();
        return finishSeen;
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = chunks
    .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.delta)
    .join('');
  return { chunks, text, finishSeen };
}

describe('citation access recheck in the session (D-26)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a citation whose chunk the recheck did not return, before the finish metadata is built', async () => {
    const asked: string[][] = [];
    const citationSession = session(async (ids) => {
      asked.push([...ids]);
      return new Set(['chunk-1']);
    });
    const { text, finishSeen } = await run(citationSession, ['One [S1] two [S2].']);

    expect(asked).toEqual([['chunk-1', 'chunk-2']]);
    expect(text).toBe('One [S1] two [S2].');
    expect(finishSeen?.citations?.map((citation) => citation.alias)).toEqual(['S1']);
    expect(finishSeen?.citations?.map((citation) => citation.n)).toEqual([1]);
    expect(finishSeen?.accessViolations).toBe(1);
    expect(citationSession.fullRecords()?.citations.map((citation) => citation.alias)).toEqual(['S1']);
    expect(citationSession.accessCheck()).toEqual({ violations: 1, failed: false, chunkIds: ['chunk-2'], documentIds: ['doc-2'] });
  });

  it('drops every citation and flags the answer when the recheck rejects, without blocking the stream', async () => {
    const citationSession = session(async () => {
      throw new Error('lookup failed');
    });
    const { text, finishSeen } = await run(citationSession, ['One [S1] two [S2].']);

    expect(text).toBe('One [S1] two [S2].');
    expect(finishSeen?.citations).toEqual([]);
    expect(finishSeen?.accessViolations).toBe(2);
    expect(citationSession.fullRecords()?.citations).toEqual([]);
    expect(citationSession.accessCheck()?.failed).toBe(true);
  });

  it('keeps every citation and adds no accessViolations when all cited chunks are visible', async () => {
    const citationSession = session(async (ids) => new Set(ids));
    const { finishSeen } = await run(citationSession, ['One [S1] two [S2].']);
    expect(finishSeen?.citations?.map((citation) => citation.alias)).toEqual(['S1', 'S2']);
    expect(finishSeen).not.toHaveProperty('accessViolations');
    expect(citationSession.accessCheck()).toEqual({ violations: 0, failed: false, chunkIds: [], documentIds: [] });
  });

  it('without recheck (mode off) adds no transform and the metadata equals today', async () => {
    const off = session();
    expect(off.transforms()).toHaveLength(1);
    const { finishSeen } = await run(off, ['One [S1] two [S2].']);
    expect(finishSeen).toEqual({
      citations: finishSeen?.citations,
      citationStrategy: 'chunk-alias',
      invalidCitations: 0,
    });
    expect(finishSeen?.citations?.map((citation) => citation.alias)).toEqual(['S1', 'S2']);
    expect(off.accessCheck()).toBeNull();
    expect(session(async (ids) => new Set(ids)).transforms()).toHaveLength(2);
  });

  it('the non-streamed path drops a denied citation the same way', async () => {
    const citationSession = session(async () => new Set(['chunk-2']));
    await citationSession.ingestFullText('One [S1] two [S2].');
    expect(citationSession.finishMetadata()).toMatchObject({ accessViolations: 1 });
    expect(citationSession.finishMetadata().citations?.map((citation) => citation.alias)).toEqual(['S2']);
  });
});

describe('chat route citation recheck (D-26)', () => {
  let fixture: RouteFixture;
  let model: string;

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
    const id = models.map((entry) => entry.id).find((candidate) => !/gpt-4|o1|chatgpt/.test(candidate) && !candidate.includes('claude') && candidate !== 'auto');
    if (!id) throw new Error('no non-GPT fixture model configured');
    model = id;
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.state.deltas = ['ok'];
    h.state.recheck = null;
    h.state.asked.length = 0;
    h.state.events.length = 0;
    h.exa.reset();
    process.env.RAG_CITATIONS = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.RAG_CITATIONS;
    vi.restoreAllMocks();
  });

  async function post() {
    const { POST } = await fixture.loadRoute('chat');
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the refund window for annual plans?' }],
        data: { ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } },
      }),
    );
    const body = await response.text();
    const chunks = body
      .split('\n')
      .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim()) as { type?: string; messageMetadata?: Record<string, unknown> };
        } catch {
          return {};
        }
      });
    return { body, finish: chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata };
  }

  function traceLines(): string[] {
    return vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.startsWith('[RAG Trace]'));
  }

  it('drops a cited chunk the caller may not see, schedules one id-only security event and records access_violation on the trace', async () => {
    h.state.deltas = ['Answer [S1].'];
    h.state.recheck = async () => new Set();
    const { body, finish } = await post();

    expect(h.state.asked).toHaveLength(1);
    expect(h.state.asked[0].length).toBeGreaterThan(0);
    expect(finish?.citations).toEqual([]);
    expect(finish?.accessViolations).toBe(1);
    expect(body).not.toMatch(/restricted|access_violation/i);

    expect(h.state.events).toHaveLength(1);
    const event = h.state.events[0];
    expect(Object.keys(event).sort()).toEqual(['chunkIds', 'documentIds', 'event', 'requestId']);
    expect(event.event).toBe('citation_access_violation');
    expect((event.chunkIds as string[]).length).toBe(1);
    expect((event.documentIds as string[]).length).toBe(1);
    expect(typeof event.requestId).toBe('string');

    const lines = traceLines();
    expect(lines.some((line) => line.includes('"access_violation"'))).toBe(true);
  });

  it('a recheck failure drops every citation, flags the trace and writes no event', async () => {
    h.state.deltas = ['Answer [S1].'];
    h.state.recheck = async () => {
      throw new Error('lookup failed');
    };
    const { finish } = await post();
    expect(finish?.citations).toEqual([]);
    expect(finish?.accessViolations).toBe(1);
    expect(h.state.events).toEqual([]);
    expect(traceLines().some((line) => line.includes('"access_recheck_failed"'))).toBe(true);
  });

  it('with access groups off no recheck runs and the finish metadata carries no accessViolations', async () => {
    h.state.deltas = ['Answer [S1].'];
    const { finish } = await post();
    expect(h.state.asked).toEqual([]);
    expect(finish).not.toHaveProperty('accessViolations');
    expect((finish?.citations as unknown[] | undefined)?.length).toBe(1);
    expect(h.state.events).toEqual([]);
    expect(traceLines().every((line) => !line.includes('access_'))).toBe(true);
  });
});
