import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { CitationRecordSchema } from '@/lib/rag-eval/contracts.generated';
import { attachedDocumentsSentence } from '@/lib/rag/generation/citations/instructions';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { FAKE_ANTHROPIC_KEY, readAnthropicFixture } from '../../helpers/fake-anthropic';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const SESSION_USER = '00000000-0000-4000-8000-00000000c516';
const CLAUDE_MODEL = 'anthropic/claude-sonnet-5.5';
const UNMAPPED_CLAUDE = 'anthropic/claude-sonnet-4.5';
const CITED_TEXT = 'The blue lantern festival moved to May this year.';
const QUESTION = 'What is the refund window for annual plans?';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['Fallback answer [S1].'] as string[] };
  const calls: Array<{ modelId: string; prompt: Array<{ role: string; content: unknown }> }> = [];
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async (options) => {
        calls.push({ modelId, prompt: options.prompt as Array<{ role: string; content: unknown }> });
        return {
          stream: convertArrayToReadableStream([
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
        };
      },
    });
  const session = { userId: null as string | null };
  return {
    state,
    calls,
    model,
    session,
    traces: [] as Array<Array<{ name: string; rules: string[] }>>,
    scheduled: [] as unknown[],
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) } },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => h.model(modelId),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: (input: unknown) => {
    h.scheduled.push(input);
  },
}));
vi.mock('@/lib/rag/trace/finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/trace/finish')>()),
  finishTrace: (collector: { stages(): Array<{ name: string; rules: string[] }> }) => {
    h.traces.push(collector.stages());
  },
}));
vi.mock('@/lib/rag/generation/citations/fallback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/citations/fallback')>()),
  CLAUDE_FIRST_TOKEN_TIMEOUT_MS: 400,
}));

const IMAGE_BLOCK = {
  documentId: 'doc-floorplan',
  documentName: 'warehouse-floorplan.png',
  documentVersion: 1,
  chunkIds: ['chunk-floorplan'],
  page: null,
  sectionPath: null,
  title: 'warehouse-floorplan.png',
  text: 'Image caption: thermal probes sit in aisle 7.',
  isImage: true,
  alias: null,
};

type FakeMode =
  | { kind: 'sse'; sse: string }
  | { kind: 'status'; status: number; body: unknown }
  | { kind: 'hang' };

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}

const fake = {
  mode: { kind: 'sse', sse: readAnthropicFixture('citations.sse') } as FakeMode,
  requests: [] as CapturedRequest[],
  sockets: new Set<Socket>(),
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    fake.requests.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    const mode = fake.mode;
    if (mode.kind === 'hang') return;
    if (mode.kind === 'status') {
      res.writeHead(mode.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(mode.sse);
  });
});
server.on('connection', (socket) => {
  fake.sockets.add(socket);
  socket.on('close', () => fake.sockets.delete(socket));
});

interface SseChunk {
  type?: string;
  delta?: string;
  errorText?: string;
  messageMetadata?: Record<string, unknown>;
  source_images?: unknown[];
}

function parseSse(body: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(payload) as SseChunk);
    } catch {
      continue;
    }
  }
  return chunks;
}

function normalizeIds(body: string): string {
  return body.replace(/"(id|messageId|toolCallId|ragTraceId|answerId)":"[^"]*"/g, '"$1":"<id>"');
}

function streamedText(chunks: SseChunk[]): string {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta ?? '').join('');
}

function metadataOf(chunks: SseChunk[], type: string): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === type)?.messageMetadata;
}

function lastUserContent(request: CapturedRequest): Array<Record<string, any>> {
  const messages = request.body.messages as Array<{ role: string; content: Array<Record<string, any>> }>;
  return messages[messages.length - 1].content;
}

function systemOf(prompt: Array<{ role: string; content: unknown }>): string {
  return prompt
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n\n');
}

function generationRules(): string[] {
  const stages = h.traces.at(-1) ?? [];
  return stages.filter((stage) => stage.name === 'generation').flatMap((stage) => stage.rules);
}

describe('chat route on the direct Claude Citations path (D-09, D-10)', () => {
  let fixture: RouteFixture;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
  });

  afterAll(async () => {
    await fixture.close();
    for (const socket of fake.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    fake.requests.length = 0;
    fake.mode = { kind: 'sse', sse: readAnthropicFixture('citations.sse') };
    h.calls.length = 0;
    h.traces.length = 0;
    h.scheduled.length = 0;
    h.state.deltas = ['Fallback answer [S1].'];
    h.session.userId = SESSION_USER;
    h.exa.reset();
    process.env.RAG_CLAUDE_CITATIONS = 'true';
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of ['RAG_CITATIONS', 'RAG_CLAUDE_CITATIONS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) delete process.env[name];
    for (const socket of fake.sockets) socket.destroy();
  });

  async function post(
    data: Record<string, unknown>,
    messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: QUESTION }],
  ) {
    const { POST } = await fixture.loadRoute('chat');
    const response = await POST(chatRequest({ messages: messages as never, data }));
    const body = await response.text();
    return { body, chunks: parseSse(body) };
  }

  const claudeTurn = (overrides: Record<string, unknown> = {}) => ({
    ragMode: 'strict',
    settings: { model: CLAUDE_MODEL, webSearch: false },
    capabilities: { citations: true },
    ...overrides,
  });

  it('sends one citation document per block and streams [S<k>] markers with claude-citations records', async () => {
    const { chunks } = await post(claudeTurn());

    expect(fake.requests).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
    const request = fake.requests[0];
    expect(request.url).toBe('/v1/messages');
    expect(request.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    expect(request.body.model).toBe('claude-sonnet-5-5');
    expect(Object.keys(request.body).filter((key) => /output|format|temperature|top_p|top_k/.test(key))).toEqual([]);

    const documents = lastUserContent(request).filter((part) => part.type === 'document');
    expect(documents.length).toBeGreaterThanOrEqual(2);
    for (const document of documents) {
      expect(document.citations).toEqual({ enabled: true });
      expect(document.source.media_type).toBe('text/plain');
    }
    expect(lastUserContent(request).at(-1)).toMatchObject({ type: 'text', text: QUESTION });

    const system = typeof request.body.system === 'string' ? request.body.system : JSON.stringify(request.body.system);
    expect(system).toContain(attachedDocumentsSentence('en'));
    expect(system).not.toContain('{{context}}');
    expect(system).not.toMatch(/\[S1\] /);

    expect(streamedText(chunks)).toContain('[S2]');
    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    const start = metadataOf(chunks, 'start');
    const finish = metadataOf(chunks, 'finish');
    expect(typeof start?.answerId).toBe('string');
    expect(finish?.answerId).toBe(start?.answerId);
    expect(finish?.citationStrategy).toBe('claude-citations');
    const citations = z.array(CitationRecordSchema).parse(finish?.citations);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ alias: 'S2', strategy: 'claude-citations', quote: CITED_TEXT });
    expect(generationRules().some((rule) => rule.startsWith('citation_strategy_fallback'))).toBe(false);
  });

  it.each([
    ['status_429', { kind: 'status', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'provider detail' } } }],
    ['status_404', { kind: 'status', status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonnet-5-5' } } }],
    ['status_401', { kind: 'status', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }],
    ['error', { kind: 'sse', sse: readAnthropicFixture('error-before-first-token.sse') }],
    ['refusal', { kind: 'sse', sse: readAnthropicFixture('refusal-before-first-token.sse') }],
    ['timeout', { kind: 'hang' }],
  ] as Array<[string, FakeMode]>)('a %s failure before the first token retries once on OpenRouter with chunk-alias', async (reason, mode) => {
    fake.mode = mode;
    const { body, chunks } = await post(claudeTurn());

    expect(fake.requests).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].modelId).toBe(CLAUDE_MODEL);
    const system = systemOf(h.calls[0].prompt);
    expect(system).toMatch(/^\[S1\] /m);
    expect(system).toContain('[S<number>]');

    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(body).not.toContain('provider detail');
    expect(body).not.toContain('invalid x-api-key');
    expect(streamedText(chunks)).toBe('Fallback answer [S1].');
    const start = metadataOf(chunks, 'start');
    const finish = metadataOf(chunks, 'finish');
    expect(typeof start?.answerId).toBe('string');
    expect(finish?.answerId).toBe(start?.answerId);
    expect(finish?.citationStrategy).toBe('chunk-alias');
    expect(z.array(CitationRecordSchema).parse(finish?.citations).map((c) => [c.alias, c.strategy])).toEqual([['S1', 'chunk-alias']]);
    expect(generationRules()).toContain(`citation_strategy_fallback:${reason}`);
  });

  it('reports a stream error after the first text delta in-band and does not retry', async () => {
    const sse = readAnthropicFixture('citations.sse').replace(
      /event: content_block_stop\ndata: \{"type":"content_block_stop","index":0\}[\s\S]*$/,
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    fake.mode = { kind: 'sse', sse };
    const { chunks } = await post(claudeTurn());

    expect(fake.requests).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
    expect(streamedText(chunks)).toContain('According to the attached notes');
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    expect(generationRules().some((rule) => rule.startsWith('citation_strategy_fallback'))).toBe(false);
  });

  it('with RAG_CLAUDE_CITATIONS=false goes to OpenRouter with the same body as with the switch unset', async () => {
    h.state.deltas = ['Plain answer [S1].'];
    const run = async () => {
      const { body } = await post(claudeTurn());
      return { sse: normalizeIds(body), system: systemOf(h.calls.at(-1)?.prompt ?? []) };
    };
    process.env.RAG_CLAUDE_CITATIONS = 'false';
    const off = await run();
    delete process.env.RAG_CLAUDE_CITATIONS;
    const unset = await run();

    expect(fake.requests).toHaveLength(0);
    expect(h.calls).toHaveLength(2);
    expect(off.system).toBe(unset.system);
    expect(off.sse).toBe(unset.sse);
    expect(off.system).not.toMatch(/^\[S1\] /m);
    expect(off.sse).not.toContain('citationStrategy');
  });

  it.each([
    ['an unmapped model', claudeTurn({ settings: { model: UNMAPPED_CLAUDE, webSearch: false } }), [{ role: 'user', content: QUESTION }]],
    ['a webSearch turn', claudeTurn({ settings: { model: CLAUDE_MODEL, webSearch: true } }), [{ role: 'user', content: QUESTION }]],
    ['a multi-step turn', claudeTurn(), [{ role: 'user', content: 'Find the refund window and then create a gmail draft with it' }]],
    [
      'a turn after a tool call awaiting approval',
      claudeTurn(),
      [
        { role: 'user', content: 'Draft an email about refunds.' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'gmail_create_draft', args: {} }] },
        { role: 'user', content: QUESTION },
      ],
    ],
    ['a turn without the citations capability', { ragMode: 'strict', settings: { model: CLAUDE_MODEL, webSearch: false } }, [{ role: 'user', content: QUESTION }]],
  ] as Array<[string, Record<string, unknown>, Array<{ role: string; content: unknown }>]>)(
    'sends %s to OpenRouter and never to the direct server',
    async (_label, data, messages) => {
      const { chunks } = await post(data, messages);
      expect(fake.requests).toHaveLength(0);
      expect(metadataOf(chunks, 'finish')?.citationStrategy).not.toBe('claude-citations');
    },
  );

  it('an ineligible turn with RAG_CITATIONS on takes chunk-alias', async () => {
    process.env.RAG_CITATIONS = 'true';
    const { chunks } = await post(claudeTurn({ settings: { model: CLAUDE_MODEL, webSearch: true } }));
    expect(fake.requests).toHaveLength(0);
    expect(metadataOf(chunks, 'finish')?.citationStrategy).toBe('chunk-alias');
  });

  it('still writes source_images and the metadata part first on the direct path', async () => {
    vi.doMock('@/lib/rag/pipeline', async () => {
      const actual = await vi.importActual<typeof import('@/lib/rag/pipeline')>('@/lib/rag/pipeline');
      return {
        ...actual,
        runRetrieval: async (...args: Parameters<typeof actual.runRetrieval>) => {
          const result = await actual.runRetrieval(...args);
          return {
            ...result,
            blocks: [...(result.blocks ?? []), IMAGE_BLOCK],
            sourceImages: [{ name: 'warehouse-floorplan.png', size: 0, type: 'image/jpeg', url: 'https://example.com/fixtures/warehouse-floorplan.png' }],
          };
        },
      };
    });
    let chunks: SseChunk[];
    try {
      ({ chunks } = await post(claudeTurn()));
    } finally {
      vi.doUnmock('@/lib/rag/pipeline');
    }

    expect(fake.requests).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
    const types = chunks.map((chunk) => chunk.type);
    const imageIndex = types.indexOf('source_images');
    const firstText = types.indexOf('text-delta');
    expect(imageIndex).toBeGreaterThan(-1);
    expect(types.indexOf('metadata')).toBeGreaterThan(imageIndex);
    expect(firstText).toBeGreaterThan(types.indexOf('metadata'));
    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(0);
    expect(metadataOf(chunks, 'finish')?.citationStrategy).toBe('claude-citations');
    expect(typeof metadataOf(chunks, 'finish')?.answerId).toBe('string');
    const system = JSON.stringify(fake.requests[0].body.system);
    expect(system).toContain('Image caption: thermal probes sit in aisle 7.');
    const documents = lastUserContent(fake.requests[0]).filter((part) => part.type === 'document');
    expect(documents.some((document) => String(document.source.data).includes('aisle 7'))).toBe(false);
  });
});
