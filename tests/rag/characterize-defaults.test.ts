import fs from 'node:fs';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { env } from '@/lib/env';
import { knowledgeBaseUnavailableMessage, noKnowledgeBaseResponse } from '@/lib/rag/generation/messages';
import { LANGUAGES_NOT_CONFIGURED } from '@/lib/rag/lang/resolve';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { loadPinnedEvalEnv } from '../../eval/harness/eval-env.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { chatRequest } from '../helpers/chat-route-fakes';
import {
  expectCharacterization,
  GOLDEN_PATH,
  INTERNAL_API_KEY,
  startRouteFixture,
  systemTextOf,
  type RouteFixture,
} from '../helpers/route-fixture';

interface Traced {
  status: string;
  reason: string;
  stages: Array<{ name: string; status: string; detail?: string }>;
  sourceImages: string[];
}

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
    traced: [] as Traced[],
  };
});

vi.mock('@/lib/rag/trace/finish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
  return {
    ...actual,
    finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
      const result = args[1];
      h.traced.push({
        status: result.status,
        reason: result.reason,
        stages: result.stages.map((stage) => ({ name: stage.name, status: stage.status, detail: stage.detail })),
        sourceImages: result.sourceImages.map((image) => image.url ?? ''),
      });
      return actual.finishTrace(...args);
    },
  };
});
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStreamResponse: () => new Response('ok'),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

/**
 * Phase 4.1 D-01 set, every value explicit so the suite reads nothing from the eval pin and gives the same snapshots
 * before and after the shipped defaults change. Languages as CI and the eval pin set them (D-24).
 */
const D01_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'auto',
  RAG_REFUSAL_THRESHOLD: 'true',
  RAG_REFUSAL_FLOOR: 'legacy_rule',
  RAG_RERANK_TIER_CHAT: 'quality',
  RAG_RERANK_TIER_VOICE: 'fast',
  RAG_CONTEXT_EDGE_ORDER: 'false',
  RAG_CONTEXT_COMPRESSION: 'false',
  RAG_CONTEXT_TOKEN_BUDGET: '6000',
  RAG_PARENT_CHILD: 'false',
  RAG_HNSW_ITERATIVE_SCAN: 'off',
  RAG_EXACT_SCAN_CUTOFF: '0',
  RAG_LEXICAL_TRANSLATION: 'false',
  RAG_EXACT_ID_LOOKUP: 'false',
  RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
  RAG_PRIMARY_LANGUAGE: 'en',
  COHERE_API_KEY: '',
};

const TOKEN_SECRET = crypto.randomBytes(24).toString('hex');
const EXA_PLACEHOLDER = 'exa-fixture-placeholder-key-00000000';
const GPT_PATTERN = /gpt-4|o1|chatgpt/;
const IMAGE_QUESTION = 'Which aisles hold thermal probes according to the floor plan?';
const IMAGE_URL = 'https://example.com/fixtures/warehouse-floorplan.png';
const UNAVAILABLE_EN = 'The knowledge base is temporarily unavailable';
const NOT_AVAILABLE = 'Information Not Available';
const LOCALIZED_NOT_AVAILABLE = ['es', 'en'].map((language) => noKnowledgeBaseResponse(language).split('\n')[0]!.replace(/^# /, ''));
const VOICE_INTENT_QUERIES = [
  'show me the warehouse floorplan image',
  'warehouse floorplan picture',
  'what does the logo look like',
  'who created this',
  'floorplan',
  'logo',
];

interface GoldenItem {
  id: string;
  question: string;
  category: string;
  answerable: boolean;
  gold_evidence: Array<{ quote: string }>;
}

function readGolden(): GoldenItem[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GoldenItem);
}

function configuredModelIds(): string[] {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((model) => model.id);
}

function readSseText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta;
    } catch {
      continue;
    }
  }
  return text;
}

function readSourceImages(body: string): unknown[] {
  const images: unknown[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const chunk = JSON.parse(line.slice(5).trim()) as { type?: string; data?: unknown; source_images?: unknown };
      const part = (chunk.type === 'data-source_images' ? chunk.data : chunk) as { source_images?: unknown } | undefined;
      if (Array.isArray(part?.source_images)) images.push(...part.source_images);
    } catch {
      continue;
    }
  }
  return images;
}

function embedRequest(question: string): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
}

function voiceRequest(query: string, scopeToken: string): NextRequest {
  return new NextRequest('http://localhost/api/internal/voice-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': scopeToken },
    body: JSON.stringify({ query, matchCount: 5 }),
  });
}

function mintSingleTenantVoiceToken(): string {
  const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: TOKEN_SECRET, ttlSeconds: 3600 });
  if (!minted.ok) throw new Error(`token mint failed: ${minted.reason}`);
  return minted.token;
}

function hybridCalls(fixture: RouteFixture): number {
  return fixture.edge.calls.filter((call) => call.path === '/rest/v1/rpc/hybrid_search_chunks').length;
}

function legacyMatchCalls(fixture: RouteFixture): number {
  return fixture.edge.calls.filter((call) => /\/rest\/v1\/rpc\/(match_document_chunks|match_documents_by_workspace)$/.test(call.path)).length;
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function postChat(fixture: RouteFixture, question: string, data: Record<string, unknown>) {
  const { POST } = await fixture.loadRoute('chat');
  h.capture.reset();
  const response = await POST(chatRequest({ messages: [{ role: 'user', content: question }], data }));
  return { response, body: await response.text() };
}

async function collectChat(fixture: RouteFixture): Promise<Array<Record<string, unknown>>> {
  const models = configuredModelIds();
  const kinds: Array<{ kind: 'other' | 'gpt'; model: string }> = [
    { kind: 'other', model: models.find((id) => !GPT_PATTERN.test(id) && !id.includes('claude')) as string },
    { kind: 'gpt', model: models.find((id) => GPT_PATTERN.test(id)) as string },
  ];
  const { POST } = await fixture.loadRoute('chat');
  const actual: Array<Record<string, unknown>> = [];
  for (const { kind, model } of kinds) {
    for (const { id, question } of readGolden()) {
      h.capture.reset();
      const response = await POST(
        chatRequest({
          messages: [{ role: 'user', content: question }],
          data: { ragMode: 'strict', settings: { webSearch: false, model } },
        }),
      );
      const body = await response.text();
      if (h.capture.calls.length === 0) {
        const text = readSseText(body);
        expect(text, `chat route neither refused nor reached streamText for ${id} (${kind})`).not.toBe('');
        actual.push({ id, model_kind: kind, refused: true, text });
      } else {
        expect(h.capture.calls).toHaveLength(1);
        actual.push({ id, model_kind: kind, system: systemTextOf(h.capture.calls[0]), source_images: readSourceImages(body) });
      }
    }
  }
  return actual;
}

async function collectEmbed(fixture: RouteFixture): Promise<Array<{ id: string; system: string }>> {
  const { POST } = await fixture.loadRoute('embed/chat');
  const actual: Array<{ id: string; system: string }> = [];
  for (const { id, question } of readGolden()) {
    h.capture.reset();
    const response = await POST(embedRequest(question));
    await response.text();
    expect(h.capture.calls, `embed route did not reach streamText for ${id}`).toHaveLength(1);
    actual.push({ id, system: systemTextOf(h.capture.calls[0]) });
  }
  return actual;
}

async function collectVoice(fixture: RouteFixture): Promise<Array<{ query: string; results: unknown; source_images: unknown }>> {
  const { POST } = await fixture.loadRoute('internal/voice-rag');
  const token = mintSingleTenantVoiceToken();
  const queries = [...readGolden().map((item) => item.question), ...VOICE_INTENT_QUERIES];
  const actual: Array<{ query: string; results: unknown; source_images: unknown }> = [];
  for (const query of queries) {
    const response = await POST(voiceRequest(query, token));
    expect(response.status, `voice-rag failed for: ${query}`).toBe(200);
    const body = (await response.json()) as { results?: unknown; source_images?: unknown };
    actual.push({ query, results: body.results ?? [], source_images: body.source_images ?? [] });
  }
  return actual;
}

function quietConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('defaults characterization (Phase 4.1 D-01 set, explicit)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({
      deploymentMode: 'single-tenant',
      env: { ...D01_ENV, EXA_API_KEY: EXA_PLACEHOLDER, RAG_VOICE_TOKEN_SECRET: TOKEN_SECRET },
    });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.traced.length = 0;
    quietConsole();
  });

  it('defaults run is served by v2', async () => {
    const answerable = readGolden().find((item) => item.answerable && item.category === 'general') as GoldenItem;
    const hybridBefore = hybridCalls(fixture);
    const legacyBefore = legacyMatchCalls(fixture);
    await postChat(fixture, answerable.question, { ragMode: 'strict', settings: { webSearch: false } });
    expect(hybridCalls(fixture) - hybridBefore, 'chat under the D-01 set did not call hybrid_search_chunks').toBeGreaterThan(0);
    expect(legacyMatchCalls(fixture) - legacyBefore).toBe(0);
    expect(h.traced.at(-1)?.stages.some((stage) => stage.name === 'rerank')).toBe(true);

    const embedBefore = hybridCalls(fixture);
    const { POST: embedPost } = await fixture.loadRoute('embed/chat');
    await (await embedPost(embedRequest(answerable.question))).text();
    expect(hybridCalls(fixture) - embedBefore, 'embed under the D-01 set did not call hybrid_search_chunks').toBeGreaterThan(0);

    const voiceBefore = hybridCalls(fixture);
    const { POST: voicePost } = await fixture.loadRoute('internal/voice-rag');
    expect((await voicePost(voiceRequest(answerable.question, mintSingleTenantVoiceToken()))).status).toBe(200);
    expect(hybridCalls(fixture) - voiceBefore, 'voice under the D-01 set did not call hybrid_search_chunks').toBeGreaterThan(0);
    expect(legacyMatchCalls(fixture) - legacyBefore).toBe(0);
  });

  it('chat: same system prompt or refusal for every fixture question and model kind', async () => {
    const actual = await collectChat(fixture);
    expect(actual).toHaveLength(readGolden().length * 2);
    expectCharacterization('chat-v2-default', actual);
  });

  it('embed: same system prompt for every fixture question', async () => {
    const errorsBefore = fixture.edge.errors.length;
    const actual = await collectEmbed(fixture);
    expect(actual.every((entry) => entry.system.length > 0)).toBe(true);
    expect(fixture.edge.errors.slice(errorsBefore)).toEqual([]);
    expectCharacterization('embed-v2-default', actual);
  });

  it('voice: same results and source images for every fixture and intent query', async () => {
    const actual = await collectVoice(fixture);
    expect(actual.some((entry) => Array.isArray(entry.results) && entry.results.length > 0)).toBe(true);
    expectCharacterization('voice-v2-default', actual);
  });

  it('strict empty answers information not available', async () => {
    const noAnswer = readGolden().filter((item) => item.category === 'no_answer');
    expect(noAnswer.length).toBeGreaterThan(0);
    let empties = 0;
    for (const item of noAnswer) {
      h.traced.length = 0;
      const { body } = await postChat(fixture, item.question, { ragMode: 'strict', settings: { webSearch: false } });
      expect(h.traced, `no trace for ${item.id}`).toHaveLength(1);
      if (h.traced[0].status !== 'empty') continue;
      empties += 1;
      expect(
        LOCALIZED_NOT_AVAILABLE.some((title) => readSseText(body).includes(title)),
        `strict empty retrieval for ${item.id} did not answer information not available`,
      ).toBe(true);
      expect(body).not.toContain(UNAVAILABLE_EN);
      expect(h.capture.streamText, `strict empty retrieval for ${item.id} reached the model`).not.toHaveBeenCalled();
    }
    expect(empties, 'no fixture no_answer item had an empty retrieval under the D-01 set').toBeGreaterThan(0);
  });

  it('backend failure is not reported as information not available', async () => {
    const answerable = readGolden().find((item) => item.answerable && item.category === 'general') as GoldenItem;
    const { body } = await withEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9' }, () =>
      postChat(fixture, answerable.question, { ragMode: 'strict', settings: { webSearch: false } }),
    );
    expect(h.traced.at(-1)?.status).toBe('error');
    expect(body).toContain(UNAVAILABLE_EN);
    expect(body).not.toContain(NOT_AVAILABLE);
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('web search stays available when strict retrieval is empty', async () => {
    const noAnswer = readGolden().filter((item) => item.category === 'no_answer');
    let checked = 0;
    for (const item of noAnswer) {
      h.traced.length = 0;
      const { body } = await postChat(fixture, item.question, { ragMode: 'strict', settings: { webSearch: true } });
      if (h.traced[0]?.status !== 'empty') continue;
      checked += 1;
      expect(body).not.toContain(NOT_AVAILABLE);
      expect(h.capture.streamText, `strict empty retrieval with web search on for ${item.id} did not reach the model`).toHaveBeenCalledTimes(1);
      expect(Object.keys(h.capture.calls[0].tools ?? {})).toContain('webSearch');
      break;
    }
    expect(checked).toBe(1);
  });

  it('source_images reach chat embed and voice', async () => {
    const { body } = await postChat(fixture, IMAGE_QUESTION, { ragMode: 'strict', settings: { webSearch: false } });
    expect(JSON.stringify(readSourceImages(body)), 'chat stream carries no source_images part').toContain(IMAGE_URL);

    // The embed wire format has no source_images field (legacy or v2); the embed request's retrieval must still carry them.
    const { POST: embedPost } = await fixture.loadRoute('embed/chat');
    h.capture.reset();
    h.traced.length = 0;
    await (await embedPost(embedRequest(IMAGE_QUESTION))).text();
    expect(h.capture.calls).toHaveLength(1);
    await h.capture.calls[0].onFinish?.({ text: '' });
    expect(h.traced).toHaveLength(1);
    expect(h.traced[0].sourceImages, 'embed retrieval lost the source image').toContain(IMAGE_URL);

    const { POST: voicePost } = await fixture.loadRoute('internal/voice-rag');
    const response = await voicePost(voiceRequest(IMAGE_QUESTION, mintSingleTenantVoiceToken()));
    const voice = (await response.json()) as { source_images?: Array<{ url: string }> };
    expect((voice.source_images ?? []).map((image) => image.url)).toContain(IMAGE_URL);
  });

  it('context placeholder substituted', async () => {
    const item = readGolden().find((entry) => entry.answerable && entry.category === 'general') as GoldenItem;
    const prompt = 'Synthetic instructions for the characterization run.\\n\\nContext:\\n{{context}}';
    const { body } = await withEnv({ RAG_SYSTEM_PROMPT: prompt }, () =>
      postChat(fixture, item.question, { ragMode: 'strict', settings: { webSearch: false } }),
    );
    expect(body).not.toContain(NOT_AVAILABLE);
    expect(h.capture.calls).toHaveLength(1);
    const system = systemTextOf(h.capture.calls[0]);
    expect(system).toContain('Synthetic instructions for the characterization run.');
    expect(system).not.toContain('{{context}}');
    expect(system).toContain(item.gold_evidence[0].quote);
  });

  it('no key means no degraded status', async () => {
    expect(process.env.COHERE_API_KEY ?? '').toBe('');
    const items = readGolden().filter((item) => item.answerable).slice(0, 12);
    const rerankBefore = fixture.edge.calls.filter((call) => call.path.endsWith('/rerank')).length;
    for (const item of items) {
      await postChat(fixture, item.question, { ragMode: 'strict', settings: { webSearch: false } });
    }
    expect(h.traced).toHaveLength(items.length);
    for (const trace of h.traced) {
      expect(trace.status, `keyless defaults degraded a request (${trace.reason})`).not.toBe('degraded');
      const rerank = trace.stages.find((stage) => stage.name === 'rerank');
      expect(rerank?.detail).toBe('auto:local_bm25');
    }
    expect(fixture.edge.calls.filter((call) => call.path.endsWith('/rerank')).length).toBe(rerankBefore);
  });
});

describe('defaults characterization (explicit v2 without languages)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({
      deploymentMode: 'single-tenant',
      env: { ...D01_ENV, RAG_SUPPORTED_LANGUAGES: undefined, RAG_PRIMARY_LANGUAGE: undefined, EXA_API_KEY: EXA_PLACEHOLDER },
    });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.traced.length = 0;
    quietConsole();
  });

  it('explicit v2 without languages reports the knowledge base as unavailable', async () => {
    const answerable = readGolden().find((item) => item.answerable && item.category === 'general') as GoldenItem;
    const hybridBefore = hybridCalls(fixture);
    const legacyBefore = legacyMatchCalls(fixture);
    const { body } = await postChat(fixture, answerable.question, { ragMode: 'strict', settings: { webSearch: false } });
    expect(h.traced.at(-1)).toMatchObject({ status: 'error', reason: LANGUAGES_NOT_CONFIGURED });
    expect(body).toContain(JSON.stringify(knowledgeBaseUnavailableMessage('en')).slice(1, -1));
    expect(body).not.toContain(NOT_AVAILABLE);
    expect(LOCALIZED_NOT_AVAILABLE.some((title) => body.includes(title))).toBe(false);
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(hybridCalls(fixture) - hybridBefore).toBe(0);
    expect(legacyMatchCalls(fixture) - legacyBefore).toBe(0);
  });

  it('explicit v2 without languages continues with web search on', async () => {
    const answerable = readGolden().find((item) => item.answerable && item.category === 'general') as GoldenItem;
    const hybridBefore = hybridCalls(fixture);
    const legacyBefore = legacyMatchCalls(fixture);
    const { body } = await postChat(fixture, answerable.question, { ragMode: 'strict', settings: { webSearch: true } });
    expect(body).not.toContain(NOT_AVAILABLE);
    expect(body).not.toContain(UNAVAILABLE_EN);
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.capture.calls[0].tools ?? {})).toContain('webSearch');
    const system = systemTextOf(h.capture.calls[0]);
    for (const evidence of answerable.gold_evidence) expect(system).not.toContain(evidence.quote);
    if (h.traced.length === 0) await h.capture.calls[0].onFinish?.({ text: '' });
    expect(h.traced.at(-1)).toMatchObject({ status: 'degraded', reason: LANGUAGES_NOT_CONFIGURED });
    expect(hybridCalls(fixture) - hybridBefore).toBe(0);
    expect(legacyMatchCalls(fixture) - legacyBefore).toBe(0);
  });
});

const OVERVIEW_QUERY = 'general information overview';

async function seedOverview(db: PGlite): Promise<void> {
  const documents = [
    {
      id: '00000000-0000-4000-8000-0000000000a9',
      filename: 'overview-notes.md',
      chunks: [
        { id: '00000000-0000-4000-8000-0000000000b9', index: 2, total: 2, embedded: `${OVERVIEW_QUERY} second part` },
        { id: '00000000-0000-4000-8000-0000000000b8', index: 1, total: 2, embedded: OVERVIEW_QUERY },
      ],
    },
    {
      id: '00000000-0000-4000-8000-0000000000aa',
      filename: 'overview-extra.md',
      chunks: [{ id: '00000000-0000-4000-8000-0000000000ba', index: 1, total: 1, embedded: 'general information shipping rates carriers' }],
    },
  ];
  for (const document of documents) {
    await db.query('INSERT INTO documents (id, filename, content, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
      document.id,
      document.filename,
      `${document.filename} overview body`,
      JSON.stringify({ relpath: `overview/${document.filename}` }),
      '2025-02-01T00:00:00.000Z',
    ]);
    for (const chunk of document.chunks) {
      await db.query(
        'INSERT INTO document_chunks (id, document_id, content, embedding, metadata, created_at) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)',
        [
          chunk.id,
          document.id,
          `Document: ${document.filename}. Chunk ${chunk.index} of ${chunk.total}. Content: ${chunk.embedded}`,
          `[${embedText(chunk.embedded).join(',')}]`,
          JSON.stringify({ chunk_index: chunk.index - 1, total_chunks: chunk.total }),
          '2025-02-01T00:00:00.000Z',
        ],
      );
    }
  }
}

describe('defaults characterization (general overview under the D-01 set)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', seed: seedOverview, env: D01_ENV });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.traced.length = 0;
    quietConsole();
  });

  it('general overview stays legacy', async () => {
    const model = configuredModelIds().find((id) => !GPT_PATTERN.test(id) && !id.includes('claude')) as string;
    const legacySnapshot = JSON.parse(fs.readFileSync(new URL('../fixtures/characterization/chat-overview.json', import.meta.url), 'utf8')) as Array<
      Record<string, unknown>
    >;
    const { POST } = await fixture.loadRoute('chat');
    const logSpy = vi.mocked(console.log);
    const hybridBefore = hybridCalls(fixture);
    const actual: Array<Record<string, unknown>> = [];
    for (const ragMode of ['strict', 'balanced', 'flexible'] as const) {
      h.capture.reset();
      logSpy.mockClear();
      const response = await POST(
        chatRequest({ messages: [{ role: 'user', content: '' }], data: { ragMode, settings: { webSearch: false, model } } }),
      );
      const body = await response.text();
      if (h.capture.calls.length === 0) {
        actual.push({ rag_mode: ragMode, refused: true, text: readSseText(body) });
      } else {
        const usedLog = logSpy.mock.calls.filter((call) => call[0] === 'API ROUTE: Used documents for context:').pop();
        actual.push({ rag_mode: ragMode, system: systemTextOf(h.capture.calls[0]), used_documents: usedLog ? usedLog[1] : null });
      }
    }
    expect(hybridCalls(fixture) - hybridBefore, 'a general overview request reached hybrid_search_chunks').toBe(0);
    expect(actual).toEqual(legacySnapshot);
  });
});

const PIN_PIPELINE = loadPinnedEvalEnv().RAG_PIPELINE ?? '';

// Plan 04.1-09 proves the shipped defaults equal D01_ENV: once the pin no longer names legacy, the same snapshots must hold with nothing set.
describe.skipIf(PIN_PIPELINE === 'legacy')('defaults suite under the pin', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { RAG_VOICE_TOKEN_SECRET: TOKEN_SECRET } });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    quietConsole();
  });

  it('chat matches chat-v2-default', async () => {
    expectCharacterization('chat-v2-default', await collectChat(fixture));
  });

  it('embed matches embed-v2-default', async () => {
    expectCharacterization('embed-v2-default', await collectEmbed(fixture));
  });

  it('voice matches voice-v2-default', async () => {
    expectCharacterization('voice-v2-default', await collectVoice(fixture));
  });
});
