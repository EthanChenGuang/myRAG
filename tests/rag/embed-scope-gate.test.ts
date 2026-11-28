import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ContextBlock, RetrievalResult } from '@/lib/rag';
import { getLanguagePack } from '@/lib/rag/lang/registry';
import { emptyRetrieval, installChatPipeline } from '../helpers/chat-route-fakes';
import { systemTextOf } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), next: { result: null as unknown } };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));

const env = process.env as Record<string, string | undefined>;
const PROCESS_ENV: Record<string, string> = {
  NEXT_PUBLIC_EMBED_ENABLED: 'true',
  NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS: '*',
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  EMBED_RATE_LIMIT: '100000',
  RAG_PIPELINE: 'v2',
  RAG_QUERY_LAYER: 'true',
  RAG_SUPPORTED_LANGUAGES: 'en,zh,it',
  RAG_PRIMARY_LANGUAGE: 'en',
};
let saved: Record<string, string | undefined>;

const QUESTION = 'Which colour do the sample widgets have?';
const SUB_A = 'What does the alpha module do?';
const SUB_B = 'What does the beta module do?';

function result(overlay: Record<string, unknown>): RetrievalResult {
  return {
    status: 'empty',
    reason: 'no_results',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: true,
    stages: [],
    traceId: 'trace-stub',
    queryContext: null,
    refusal: null,
    queryLanguage: 'en',
    queryPlan: {
      original: QUESTION,
      standalone: QUESTION,
      language: 'en',
      gate: { rewrite: false, transforms: [], reasons: [], lang: 'en', protected_tokens: [], skip_retrieval: false },
      date_range: null,
      framework: 'llamaindex',
    },
    ...overlay,
  } as unknown as RetrievalResult;
}

function gate(label: 'in_scope' | 'out_of_scope') {
  return { label, score: 0.1, negative_score: 0.4, reason: label === 'in_scope' ? 'above_threshold' : 'below_threshold', centroid_count: 3, latency_ms: 1 };
}

function block(index: number, text: string, subQuestionIndexes: number[]): ContextBlock {
  return {
    documentId: `doc-${index}`,
    documentName: `module-${index}.md`,
    documentVersion: 1,
    chunkIds: [`chunk-${index}`],
    page: null,
    sectionPath: null,
    title: `module-${index}.md`,
    text,
    isImage: false,
    alias: null,
    subQuestionIndexes,
  };
}

async function post(next: RetrievalResult) {
  h.next.result = next;
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return { ...actual, runRetrieval: async () => h.next.result };
  });
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/embed/chat/route');
  const response = await POST(
    new NextRequest('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
      body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }] }),
    }),
  );
  const chunks = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload.startsWith('{'))
    .map((payload) => JSON.parse(payload) as { type?: string; delta?: string; messageMetadata?: { rag?: Record<string, unknown> } });
  return chunks;
}

const texts = () => getLanguagePack('en')?.texts.query_layer;

describe('embed route scope-gate answers and decomposed block (D-26, D-11)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(PROCESS_ENV).map((name) => [name, env[name]]));
    Object.assign(env, PROCESS_ENV);
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    vi.restoreAllMocks();
  });

  it('out_of_scope: the stream starts with the notice, rag.scopeGate is set and the prompt carries the rule', async () => {
    h.capture.setDeltas(['A general answer.']);
    const chunks = await post(result({ reason: 'out_of_scope', skipReason: 'out_of_scope', scopeGate: gate('out_of_scope') }));
    const notice = texts()?.scope_gate_notice ?? null;
    const rule = texts()?.scope_gate_prompt_rule ?? null;
    expect(notice).not.toBeNull();
    const streamed = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta).join('');
    expect(streamed.startsWith(notice as string)).toBe(true);
    expect(streamed.endsWith('A general answer.')).toBe(true);
    expect(chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata?.rag?.scopeGate).toBe('out_of_scope');
    expect(systemTextOf(h.capture.streamText.mock.calls[0][0] as Record<string, unknown>)).toContain(rule as string);
  });

  it('in_scope: the stream and the metadata are unchanged', async () => {
    const chunks = await post(result({ scopeGate: gate('in_scope') }));
    const streamed = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta).join('');
    expect(streamed).toBe('ok');
    expect(chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata?.rag?.scopeGate).toBeUndefined();
  });

  it('a decomposed question gets the per-part block in the embed prompt', async () => {
    const blocks = [block(1, 'The alpha module sorts records.', [0]), block(2, 'The beta module archives records.', [1])];
    await post(
      result({
        status: 'ok',
        reason: 'ok',
        refusalCandidate: false,
        context: blocks.map((entry) => entry.text).join('\n\n'),
        blocks,
        queryPlan: { ...result({}).queryPlan, sub_questions: [SUB_A, SUB_B] },
      }),
    );
    const system = systemTextOf(h.capture.streamText.mock.calls[0][0] as Record<string, unknown>);
    expect(system).toContain(`1. ${SUB_A}`);
    expect(system).toContain(`2. ${SUB_B}`);
  });
});
