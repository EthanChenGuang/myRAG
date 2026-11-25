import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MockLanguageModelV3 } from 'ai/test';
import { env } from '@/lib/env';
import { NO_CONTEXT_TEXT } from '@/lib/rag/context/assemble';
import { REFERENCE_NOTICE, REFERENCE_REMINDER } from '@/lib/rag/context/wrap';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, systemTextOf, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => {
    const result = await h.capture.streamText(params);
    return { ...result, toUIMessageStreamResponse: result.toUIMessageStreamResponse ?? (() => new Response('ok')) };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

/** Neutral synthetic fixture text only. */
const QUESTION = 'How does the quillmark relay calibrate its phase offset?';
const UNKNOWN_QUESTION = 'zyxwv qpqpq vrvrv nonexistent topic marker';
const MAIN_TEXT = 'The quillmark relay calibrates its phase offset against the reference beacon. See https://example.invalid/quillmark-guide for the procedure.';
const SECOND_TEXT = 'Quillmark relay phase offset calibration repeats every startup cycle.';
const CAPTION_TEXT = 'Diagram of the quillmark relay phase offset calibration loop.';
const APPENDIX_TEXT = 'Lumen appendix: the relay housing uses a sealed enclosure.';
const LINK_URL = 'https://example.invalid/quillmark-guide';
const IMAGE_URL = 'https://example.invalid/quillmark-loop.png';
const APPENDIX_FILE = 'lumen-appendix.md';

const DOC_MAIN = '00000000-0000-4000-8000-00000000c501';
const DOC_IMAGE = '00000000-0000-4000-8000-00000000c502';
const DOC_APPENDIX = '00000000-0000-4000-8000-00000000c503';
const DOC_OVERVIEW = '00000000-0000-4000-8000-00000000c504';
const OVERVIEW_TEXT = 'general information overview of the quillmark relay family';

const EVAL_SECRET = 'e'.repeat(48);
const SWITCHES = ['RAG_CONTEXT_TAGGING', 'RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED'] as const;

async function insertDocument(db: PGlite, id: string, filename: string, content: string): Promise<void> {
  await db.query('INSERT INTO documents (id, filename, content, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
    id,
    filename,
    content,
    JSON.stringify({ relpath: `entrypoints/${filename}`, language: 'en' }),
    '2025-03-01T00:00:00.000Z',
  ]);
}

async function insertChunk(
  db: PGlite,
  row: { id: string; documentId: string; filename: string; index: number; total: number; text: string; embedded: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    'INSERT INTO document_chunks (id, document_id, content, embedding, metadata, created_at) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)',
    [
      row.id,
      row.documentId,
      `Document: ${row.filename}. Chunk ${row.index + 1} of ${row.total}. Content: ${row.text}`,
      `[${embedText(row.embedded).join(',')}]`,
      JSON.stringify({ document_title: row.filename, chunk_index: row.index, total_chunks: row.total, ...(row.metadata ?? {}) }),
      '2025-03-01T00:00:00.000Z',
    ],
  );
}

async function seed(db: PGlite): Promise<void> {
  await insertDocument(db, DOC_MAIN, 'quillmark-relay.md', `${MAIN_TEXT}\n\n${SECOND_TEXT}`);
  await insertDocument(db, DOC_IMAGE, 'quillmark-loop-notes.md', CAPTION_TEXT);
  await insertDocument(db, DOC_APPENDIX, APPENDIX_FILE, APPENDIX_TEXT);
  await insertChunk(db, { id: '00000000-0000-4000-8000-00000000c511', documentId: DOC_MAIN, filename: 'quillmark-relay.md', index: 0, total: 2, text: MAIN_TEXT, embedded: QUESTION, metadata: { urls: [{ url: LINK_URL, context: 'the procedure', category: 'documentation' }] } });
  await insertChunk(db, { id: '00000000-0000-4000-8000-00000000c512', documentId: DOC_MAIN, filename: 'quillmark-relay.md', index: 1, total: 2, text: SECOND_TEXT, embedded: QUESTION });
  await insertChunk(db, {
    id: '00000000-0000-4000-8000-00000000c513',
    documentId: DOC_IMAGE,
    filename: 'quillmark-loop-notes.md',
    index: 0,
    total: 1,
    text: CAPTION_TEXT,
    embedded: QUESTION,
    metadata: { image_url: IMAGE_URL, image_context: CAPTION_TEXT, name: 'quillmark-loop-notes.md' },
  });
  await insertDocument(db, DOC_OVERVIEW, 'quillmark-overview.md', OVERVIEW_TEXT);
  await insertChunk(db, { id: '00000000-0000-4000-8000-00000000c515', documentId: DOC_OVERVIEW, filename: 'quillmark-overview.md', index: 0, total: 1, text: OVERVIEW_TEXT, embedded: 'general information overview' });
  await insertChunk(db, { id: '00000000-0000-4000-8000-00000000c514', documentId: DOC_APPENDIX, filename: APPENDIX_FILE, index: 0, total: 1, text: APPENDIX_TEXT, embedded: 'lumen appendix sealed enclosure housing' });
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The opening tags inside the documents element, in order; the structure the model sees. */
function docTags(text: string): string[] {
  const start = text.indexOf('<documents>');
  const end = text.indexOf('</documents>');
  if (start === -1 || end === -1) return [];
  return [...text.slice(start, end).matchAll(/<doc [^>]*>/g)].map((match) => match[0]);
}

function expectOneTaggedElement(text: string): void {
  expect(count(text, REFERENCE_NOTICE)).toBe(1);
  expect(count(text, REFERENCE_REMINDER)).toBe(1);
  expect(count(text, '<documents>')).toBe(1);
  expect(count(text, '</documents>')).toBe(1);
  const open = text.indexOf('<documents>');
  const close = text.indexOf('</documents>');
  expect(text.indexOf(REFERENCE_NOTICE)).toBeLessThan(open);
  expect(text.indexOf(REFERENCE_REMINDER)).toBeGreaterThan(close);
  const outside = text.slice(0, open) + text.slice(close);
  expect(outside).not.toMatch(/<doc[\s>]/);
}

function otherModel(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((model) => model.id).find((id) => !/gpt-4|o1|chatgpt/.test(id) && !id.includes('claude')) as string;
}

function embedRequest(question: string): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
}

function evalRequest(question: string, ragMode: 'strict' | 'balanced'): NextRequest {
  return new NextRequest('http://localhost/api/internal/rag/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': EVAL_SECRET },
    body: JSON.stringify({ schema_version: 1, query: question, rag_mode: ragMode, include_answer: true, options: { generator_model: 'test/eval-model' } }),
  });
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

describe('tagged context reaches every entry point once (D-01, D-02, D-04)', () => {
  let fixture: RouteFixture;
  const model = otherModel();
  const saved: Partial<Record<(typeof SWITCHES)[number], string | undefined>> = {};

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', documentFilenameFilter: true, seed });
    for (const name of SWITCHES) saved[name] = process.env[name];
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    process.env.RAG_EVAL_SECRET = EVAL_SECRET;
    process.env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of SWITCHES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.restoreAllMocks();
  });

  function tagging(on: boolean): void {
    if (on) process.env.RAG_CONTEXT_TAGGING = 'true';
    else delete process.env.RAG_CONTEXT_TAGGING;
  }

  async function chatSystem(content: string, ragMode: 'strict' | 'balanced' = 'balanced'): Promise<{ system: string | null; body: string }> {
    h.capture.reset();
    const { POST } = await fixture.loadRoute('chat');
    const response = await POST(chatRequest({ messages: [{ role: 'user', content }], data: { ragMode, settings: { webSearch: false, model } } }));
    const body = await response.text();
    return { system: h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : null, body };
  }

  async function embedSystem(question: string): Promise<string> {
    h.capture.reset();
    const { POST } = await fixture.loadRoute('embed/chat');
    const response = await POST(embedRequest(question));
    await response.text();
    expect(h.capture.calls).toHaveLength(1);
    return systemTextOf(h.capture.calls[0]);
  }

  async function evalRun(question: string, ragMode: 'strict' | 'balanced'): Promise<{ status: number; trace: Record<string, any>; prompts: string[] }> {
    const { POST } = await fixture.loadRoute<{ POST: (req: NextRequest) => Promise<Response> }>('internal/rag/run');
    const answer = await import('@/lib/rag-eval/answer');
    const prompts: string[] = [];
    answer.setEvalLanguageModelFactory(
      () =>
        new MockLanguageModelV3({
          doGenerate: async (options) => {
            const system = options.prompt.find((message) => message.role === 'system');
            prompts.push(system && typeof system.content === 'string' ? system.content : '');
            return { content: [{ type: 'text' as const, text: 'ok' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: USAGE, warnings: [] };
          },
        }),
    );
    try {
      const response = await POST(evalRequest(question, ragMode));
      return { status: response.status, trace: (await response.json()) as Record<string, any>, prompts };
    } finally {
      answer.setEvalLanguageModelFactory(null);
    }
  }

  it('chat: an @mention reference, image caption, retrieved chunks and the links section share one documents element', async () => {
    tagging(true);
    const { system } = await chatSystem(`${QUESTION} @${APPENDIX_FILE}`);
    expect(system).not.toBeNull();
    const text = system as string;
    expectOneTaggedElement(text);
    const tags = docTags(text);
    expect(tags.some((tag) => tag.includes('kind="reference"') && tag.includes(`source="${APPENDIX_FILE}"`))).toBe(true);
    expect(tags.some((tag) => /id="img1"/.test(tag) && tag.includes('kind="image"'))).toBe(true);
    expect(tags.some((tag) => /id="c1"/.test(tag))).toBe(true);
    expect(tags.some((tag) => tag.includes('id="links"') && tag.includes('kind="links"'))).toBe(true);
    const inside = text.slice(text.indexOf('<documents>'), text.indexOf('</documents>'));
    for (const fragment of [APPENDIX_TEXT, 'calibrates its phase offset against the reference beacon', CAPTION_TEXT, LINK_URL]) {
      expect(inside).toContain(fragment);
    }
  });

  it('chat: the overview fallback is wrapped in one documents element', async () => {
    tagging(true);
    const { system } = await chatSystem('', 'balanced');
    expect(system).not.toBeNull();
    expectOneTaggedElement(system as string);
    expect(docTags(system as string).length).toBeGreaterThan(0);
  });

  it('embed and eval build the same tagged structure for the same question', async () => {
    tagging(true);
    const embed = await embedSystem(QUESTION);
    const run = await evalRun(QUESTION, 'balanced');
    expect(run.status).toBe(200);
    expect(run.prompts).toHaveLength(1);
    expectOneTaggedElement(embed);
    expectOneTaggedElement(run.prompts[0]);
    expectOneTaggedElement(run.trace.context);
    expect(docTags(embed).length).toBeGreaterThan(0);
    expect(docTags(run.prompts[0])).toEqual(docTags(embed));
  });

  it('the eval prompt equals the shared assembly over the eval context with tagging on and off', async () => {
    const answer = await import('@/lib/rag-eval/answer');
    for (const on of [false, true]) {
      tagging(on);
      const run = await evalRun(QUESTION, 'balanced');
      expect(run.prompts).toHaveLength(1);
      expect(run.prompts[0]).toBe(answer.buildEvalSystemPrompt({ context: run.trace.context, ragMode: 'balanced' }));
      expect(count(run.prompts[0], '<documents>')).toBe(on ? 1 : 0);
    }
  });

  it('strict eval with no matching context refuses as today and shows no documents element', async () => {
    tagging(true);
    const run = await evalRun(UNKNOWN_QUESTION, 'strict');
    expect(run.status).toBe(200);
    expect(run.trace.refused).toBe(true);
    expect(run.prompts).toHaveLength(0);
    expect(JSON.stringify(run.trace)).not.toContain('<documents>');
    expect(JSON.stringify(run.trace)).not.toContain(REFERENCE_NOTICE);
  });

  it('embed with no matching context keeps today\'s no-context prompt and shows no documents element', async () => {
    tagging(false);
    const before = await embedSystem(UNKNOWN_QUESTION);
    tagging(true);
    const after = await embedSystem(UNKNOWN_QUESTION);
    expect(after).toBe(before);
    expect(after).toContain(NO_CONTEXT_TEXT);
    expect(after).not.toContain('<documents>');
    expect(after).not.toContain(REFERENCE_NOTICE);
  });

  it('strict chat with no matching context streams today\'s refusal and never reaches the model', async () => {
    tagging(true);
    const { system, body } = await chatSystem(UNKNOWN_QUESTION, 'strict');
    expect(system).toBeNull();
    expect(body).not.toContain('<documents>');
    expect(body).toMatch(/Information Not Available/i);
  });

  it('with tagging off no entry point shows the notice or a documents element', async () => {
    tagging(false);
    const { system } = await chatSystem(`${QUESTION} @${APPENDIX_FILE}`);
    const embed = await embedSystem(QUESTION);
    const run = await evalRun(QUESTION, 'balanced');
    for (const text of [system as string, embed, run.prompts[0], run.trace.context as string]) {
      expect(text).not.toContain(REFERENCE_NOTICE);
      expect(text).not.toContain('<documents>');
    }
  });
});
