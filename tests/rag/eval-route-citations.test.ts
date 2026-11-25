import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { streamText } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createCitationSession, type ContextBlock } from '@/lib/rag';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { citationInstruction } from '@/lib/rag/generation/citations/instructions';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const SIDECAR_SECRET = 'sidecar-secret-placeholder-0123456789';
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_SIDECAR_URL',
  'RAG_SIDECAR_SECRET',
  'RAG_CITATIONS',
  'RAG_CLAUDE_CITATIONS',
  'ANTHROPIC_API_KEY',
] as const;
const env = process.env as Record<string, string | undefined>;

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

let saved: Record<string, string | undefined>;

function chunkRow(id: string, similarity: number) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `The refund window for plan ${id} is thirty days after purchase.`,
    similarity,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  };
}

interface CapturedPrompt {
  system: string;
}

function answeringModel(text: string, prompts: CapturedPrompt[]) {
  return new MockLanguageModelV3({
    doGenerate: async (callOptions) => {
      const systemMessage = callOptions.prompt.find((message) => message.role === 'system');
      prompts.push({ system: systemMessage && typeof systemMessage.content === 'string' ? systemMessage.content : '' });
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

interface FakeSidecar {
  url: string;
  bodies: Array<Record<string, unknown>>;
  secrets: Array<string | undefined>;
  close(): Promise<void>;
}

async function startSidecar(result: Record<string, unknown>): Promise<FakeSidecar> {
  const bodies: Array<Record<string, unknown>> = [];
  const secrets: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      secrets.push(req.headers['x-sidecar-secret'] as string | undefined);
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    secrets,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function loadRoute(answerText: string, prompts: CapturedPrompt[]) {
  vi.resetModules();
  await installChatPipeline(h);
  const answer = await import('@/lib/rag-eval/answer');
  answer.setEvalLanguageModelFactory(() => answeringModel(answerText, prompts));
  const route = await import('@/app/api/internal/rag/run/route');
  return { route, answer };
}

function evalRequest(options: Record<string, unknown>, extra: Record<string, unknown> = { include_answer: true }) {
  return new NextRequest('http://localhost/api/internal/rag/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
    body: JSON.stringify({
      schema_version: 1,
      query: 'What is the refund window?',
      rag_mode: 'balanced',
      options: { generator_model: 'test/eval-model', ...options },
      ...extra,
    }),
  });
}

type Trace = ReturnType<typeof RagTraceSchema.parse>;

async function post(route: { POST: (req: NextRequest) => Promise<Response> }, request: NextRequest): Promise<{ status: number; raw: string; trace: Trace }> {
  const response = await route.POST(request);
  const raw = await response.text();
  return { status: response.status, raw, trace: JSON.parse(raw) as Trace };
}

describe('eval route citations and groundedness', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.supabase.store.reset();
    h.supabase.store.documents = [
      { id: 'doc-1', filename: 'refund-policy-1.md', created_at: '2026-01-01T00:00:00.000Z', content: 'refund policy', metadata: {} },
      { id: 'doc-2', filename: 'refund-policy-2.md', created_at: '2026-01-01T00:00:00.000Z', content: 'refund policy', metadata: {} },
    ];
    h.supabase.store.document_chunks = [
      { id: 'chunk-1', document_id: 'doc-1', metadata: null },
      { id: 'chunk-2', document_id: 'doc-2', metadata: null },
    ];
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('1', 0.92), chunkRow('2', 0.88)]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const answer = await import('@/lib/rag-eval/answer');
    answer.setEvalLanguageModelFactory(null);
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  it('labels the blocks, decorates the prompt and returns validated chunk-alias records', async () => {
    const prompts: CapturedPrompt[] = [];
    const { route } = await loadRoute('A [S1] b [S7]', prompts);
    const { status, trace } = await post(route, evalRequest({ citations: true }));

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.context).toContain('[S1]');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].system).toContain('[S1]');
    expect(prompts[0].system.endsWith(`\n\n${citationInstruction('en')}`)).toBe(true);
    expect(trace.answer).toBe('A [S1] b [S7]');
    expect(trace.citation_strategy).toBe('chunk-alias');
    expect(trace.invalid_citations).toBe(1);
    expect(trace.citations).toHaveLength(1);
    const [record] = trace.citations;
    expect(record.alias).toBe('S1');
    expect(record.n).toBe(1);
    expect(record.strategy).toBe('chunk-alias');
    expect(record.chunkIds).toEqual(['chunk-1']);
    expect(record.quote).toContain('The refund window for plan 1 is thirty days after purchase.');
    expect(trace.groundedness ?? null).toBeNull();
  });

  it('leaves the trace as today without the options', async () => {
    const prompts: CapturedPrompt[] = [];
    const { route } = await loadRoute('A [S1] b', prompts);
    const { status, trace } = await post(route, evalRequest({}));

    expect(status).toBe(200);
    expect(trace.context).not.toContain('[S1]');
    expect(prompts[0].system).not.toContain(citationInstruction('en'));
    expect(trace.citations).toEqual([]);
    expect(trace.citation_strategy ?? null).toBeNull();
    expect(trace.invalid_citations ?? 0).toBe(0);
    expect(trace.groundedness ?? null).toBeNull();
  });

  it('ignores the citation option when no answer is requested', async () => {
    const prompts: CapturedPrompt[] = [];
    const { route } = await loadRoute('unused', prompts);
    const { status, trace } = await post(route, evalRequest({ citations: true, groundedness: true }, {}));

    expect(status).toBe(200);
    expect(prompts).toHaveLength(0);
    expect(trace.context).not.toContain('[S1]');
    expect(trace.citations).toEqual([]);
    expect(trace.citation_strategy ?? null).toBeNull();
    expect(trace.groundedness ?? null).toBeNull();
  });

  it('keeps candidates, kept and used documents identical with and without citations', async () => {
    const prompts: CapturedPrompt[] = [];
    const { route } = await loadRoute('A [S1]', prompts);
    const plain = await post(route, evalRequest({}));
    const cited = await post(route, evalRequest({ citations: true }));

    expect(cited.trace.candidates).toEqual(plain.trace.candidates);
    expect(cited.trace.kept).toEqual(plain.trace.kept);
    expect(cited.trace.used_documents).toEqual(plain.trace.used_documents);
    expect(cited.trace.refused).toBe(plain.trace.refused);
  });

  it('scores groundedness against the configured sidecar when the run asks for it', async () => {
    const sidecar = await startSidecar({ status: 'scored', scorer: 'hhem_2_1_open', score: 0.91, truncated: false, latency_ms: 4 });
    try {
      env.RAG_SIDECAR_URL = sidecar.url;
      env.RAG_SIDECAR_SECRET = SIDECAR_SECRET;
      const prompts: CapturedPrompt[] = [];
      const { route } = await loadRoute('The refund window is thirty days after purchase [S1].', prompts);
      const { status, trace } = await post(route, evalRequest({ citations: true, groundedness: true }));

      expect(status).toBe(200);
      expect(sidecar.bodies).toHaveLength(1);
      expect(sidecar.secrets[0]).toBe(SIDECAR_SECRET);
      const body = sidecar.bodies[0];
      expect(body.language).toBe('en');
      expect(body.allow_vectara).toBe(false);
      expect(body.hypothesis).toBe('The refund window is thirty days after purchase.');
      expect((body.premise_texts as string[]).some((text) => text.includes('plan 1 is thirty days'))).toBe(true);
      expect(trace.groundedness?.status).toBe('scored');
      expect(trace.groundedness?.scorer).toBe('hhem_2_1_open');
      expect(trace.groundedness?.label).toBe('verified');
      expect(trace.groundedness?.score).toBe(0.91);
      expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    } finally {
      await sidecar.close();
    }
  });

  it('reports scorer_unavailable when the sidecar is not configured', async () => {
    const prompts: CapturedPrompt[] = [];
    const { route } = await loadRoute('The refund window is thirty days after purchase.', prompts);
    const { status, trace } = await post(route, evalRequest({ groundedness: true }));

    expect(status).toBe(200);
    expect(trace.citations).toEqual([]);
    expect(trace.groundedness?.status).toBe('not_checked');
    expect(trace.groundedness?.label).toBe('not_checked');
    expect(trace.groundedness?.reason).toBe('scorer_unavailable');
  });

  it('calls no sidecar without the groundedness option', async () => {
    const sidecar = await startSidecar({ status: 'scored', scorer: 'hhem_2_1_open', score: 0.5, truncated: false, latency_ms: 1 });
    try {
      env.RAG_SIDECAR_URL = sidecar.url;
      env.RAG_SIDECAR_SECRET = SIDECAR_SECRET;
      const prompts: CapturedPrompt[] = [];
      const { route } = await loadRoute('The refund window is thirty days [S1].', prompts);
      const { status, trace } = await post(route, evalRequest({ citations: true }));
      expect(status).toBe(200);
      expect(sidecar.bodies).toHaveLength(0);
      expect(trace.groundedness ?? null).toBeNull();
    } finally {
      await sidecar.close();
    }
  });
});

function sessionBlocks(): ContextBlock[] {
  return [1, 2, 3].map((index) => ({
    documentId: `doc-${index}`,
    documentName: `doc-${index}.pdf`,
    documentVersion: 1,
    chunkIds: [`chunk-${index}`],
    page: null,
    sectionPath: null,
    title: `doc-${index}.pdf`,
    text: `Block ${index} text.`,
    isImage: false,
    alias: `S${index}`,
  }));
}

function aliasSession() {
  const session = createCitationSession({
    capabilities: { citations: true },
    ragMode: 'strict',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    language: 'en',
    config: { citations: true },
  });
  session.attach({ blocks: sessionBlocks() });
  return session;
}

async function streamThrough(deltas: string[]) {
  const session = aliasSession();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      ]),
    }),
  });
  const result = streamText({ model, prompt: 'question', experimental_transform: session.transforms() });
  await result.consumeStream();
  return session.fullRecords();
}

describe('citation session ingestFullText', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('gives the same records as streaming the same text through the transform', async () => {
    const text = 'First [S2] then 【S1】 and [S3, S9] plus [S2][S1].';
    const streamed = await streamThrough(['First [S', '2] then 【', 'S1】 and [S3, S', '9] plus [S2][S1].']);
    const session = aliasSession();
    expect(typeof session.ingestFullText).toBe('function');
    session.ingestFullText(text);
    expect(session.fullRecords()).toEqual(streamed);
    expect(session.fullRecords()?.citations.map((record) => record.alias)).toEqual(['S2', 'S1', 'S3']);
    expect(session.fullRecords()?.invalidCitations).toBe(1);
    expect(session.answerText()).toBe(text);
  });

  it('does nothing without an active chunk-alias strategy', () => {
    const session = createCitationSession({ capabilities: null, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: true } });
    session.attach({ blocks: sessionBlocks() });
    expect(typeof session.ingestFullText).toBe('function');
    session.ingestFullText('A [S1]');
    expect(session.fullRecords()).toBeNull();
  });
});
