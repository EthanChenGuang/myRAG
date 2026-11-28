import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['ok'] as string[] };
  const calls: Array<{ prompt: Array<{ role: string; content: unknown }> }> = [];
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async (options) => {
        calls.push({ prompt: options.prompt as Array<{ role: string; content: unknown }> });
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            ...(state.deltas.length > 0 ? [{ type: 'text-start' as const, id: 't1' }] : []),
            ...state.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
            ...(state.deltas.length > 0 ? [{ type: 'text-end' as const, id: 't1' }] : []),
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'end_turn' },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
            },
          ]),
        };
      },
    });
  return { state, calls, model, exa: fakes.createExaFake(), ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } } };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: () => (modelId: string) => h.model(modelId) }));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const SYL = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'vo', 'ri', 'pe', 'du', 'zo', 'fa'];
const word = (seed: number) => `${SYL[seed % 12]}${SYL[(seed * 7) % 12]}${SYL[(seed * 5 + 3) % 12]}${seed % 89}`;
const PASSAGE = Array.from({ length: 40 }, (_, i) => word(500 + i)).join(' ');
const QUESTION = `${PASSAGE.split(' ').slice(0, 12).join(' ')}?`;
const COPIES = 4;
const chunkIds: string[] = [];

async function seed(db: PGlite) {
  for (let copy = 0; copy < COPIES; copy += 1) {
    const doc = crypto.randomUUID();
    const chunk = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(PASSAGE).digest('hex');
    await db.query(
      `INSERT INTO documents (id, filename, content, lineage_id, is_current, status, content_hash) VALUES ($1,$2,$3,$1,true,'ready',$4)`,
      [doc, `manual-copy-${copy}.md`, PASSAGE, hash],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, tenant_key, is_current, status, chunk_index, provisional, content_hash)
       VALUES ($1,$2,$3,$4::vector,$3,'s:default',true,'ready',0,false,$5)`,
      [chunk, doc, PASSAGE, `[${embedText(PASSAGE).join(',')}]`, hash],
    );
    chunkIds.push(chunk);
  }
}


interface SseChunk {
  type?: string;
  delta?: string;
  errorText?: string;
  finishReason?: string;
  messageMetadata?: Record<string, unknown>;
}

function parseSse(body: string): SseChunk[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as SseChunk);
}

const EMPTY_REPLY_EN = 'I could not produce an answer this time. Please try again or rephrase your question.';
const EMPTY_REPLY_ZH = '这次未能生成回答，请重试或换个问法。';

/**
 * A passage copied into several documents, clustered and collapsed to one kept chunk whose alsoIn lists the other copies,
 * answered on the chunk-alias citation path. The provider finishing without a single text delta (a refusal, a content filter or
 * an empty completion) used to stream a finish part only: the client drew an empty bubble and the server logged nothing.
 */
describe('duplicated passage + collapse + alsoIn + citations', () => {
  let fixture: RouteFixture;
  let warn: { mock: { calls: unknown[][] } };

  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'single-tenant',
      seed,
      env: {
        RAG_PIPELINE: 'v2',
        RAG_LEXICAL_SEARCH: 'true',
        RAG_VERSION_SCOPE: 'true',
        RAG_DUP_CLUSTERS: 'true',
        RAG_RESULT_DIVERSITY: 'collapse',
        RAG_CITATIONS: 'true',
        RAG_RERANKER: 'none',
      },
    });
    const { clusterChunks } = await import('@/lib/rag/dedupe/cluster');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const report = await clusterChunks(mintScope('single', null, null), chunkIds);
    expect(report.clusters).toBe(1);
  });

  afterAll(async () => fixture?.close());

  beforeEach(() => {
    h.calls.length = 0;
    h.state.deltas = ['ok'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function postChat(language = 'en') {
    const { POST } = await fixture.loadRoute<{ POST: (r: Request) => Promise<Response> }>('chat');
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: QUESTION }],
        data: { ragMode: 'strict', settings: { model: 'anthropic/claude-sonnet-4.5', webSearch: false, language }, capabilities: { citations: true } },
      }),
    );
    return parseSse(await response.text());
  }

  function ragTraceLine(): Record<string, any> | undefined {
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args[0])
      .filter((line): line is string => typeof line === 'string' && line.startsWith('[RAG Trace] '));
    const last = logged.at(-1);
    return last ? JSON.parse(last.slice('[RAG Trace] '.length)) : undefined;
  }

  it('collapses the copies into one cited block whose citation lists the dropped copies as alsoIn', async () => {
    h.state.deltas = ['The passage says so [S1].'];
    const chunks = await postChat();
    const prompt = JSON.stringify(h.calls.at(-1)?.prompt ?? []);
    expect(prompt.split(PASSAGE).length - 1).toBe(1);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta).join('')).toBe('The passage says so [S1].');
    const citations = (chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata?.citations ?? []) as Array<{ alias: string; alsoIn?: unknown[] }>;
    expect(citations.map((citation) => citation.alias)).toEqual(['S1']);
    expect(citations[0]!.alsoIn?.length).toBe(COPIES - 1);
  });

  it('an empty provider reply streams the localized empty-reply error before the finish part and logs [Chat]', async () => {
    h.state.deltas = [];
    const chunks = await postChat();
    const types = chunks.map((chunk) => chunk.type);
    expect(types).not.toContain('text-delta');
    const errorIndex = types.indexOf('error');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(chunks[errorIndex]!.errorText).toBe(EMPTY_REPLY_EN);
    expect(errorIndex).toBeLessThan(types.indexOf('finish'));
    expect(warn.mock.calls.some((args: unknown[]) => String(args[0]).startsWith('[Chat] Model reply was empty'))).toBe(true);
    const generation = (ragTraceLine()?.stages ?? []).find((stage: { name: string }) => stage.name === 'generation');
    expect(generation?.rules).toContain('empty_reply:stop');
  });

  it('the empty-reply notice follows the UI language', async () => {
    h.state.deltas = [];
    const chunks = await postChat('zh');
    expect(chunks.find((chunk) => chunk.type === 'error')?.errorText).toBe(EMPTY_REPLY_ZH);
  });

  it('embed chat: an empty provider reply streams the empty-reply error; a normal reply is unchanged', async () => {
    const embed = async () => {
      const { POST } = await fixture.loadRoute<{ POST: (r: NextRequest) => Promise<Response> }>('embed/chat');
      const response = await POST(
        new NextRequest('http://localhost/api/embed/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.34', 'accept-language': 'en' },
          body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }] }),
        }),
      );
      return parseSse(await response.text());
    };
    h.state.deltas = [];
    const empty = await embed();
    expect(empty.find((chunk) => chunk.type === 'error')?.errorText).toBe(EMPTY_REPLY_EN);
    h.state.deltas = ['fine'];
    const normal = await embed();
    expect(normal.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(normal.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta).join('')).toBe('fine');
  });
});
