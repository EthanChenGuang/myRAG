import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixedText } from '@/lib/rag/lang/texts';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { adminWithRpc } from './helpers/pipeline-fakes';
import { startRouteFixture, systemTextOf, type RouteFixture } from '../helpers/route-fixture';

/** Synthetic hosts under reserved test names only; neutral synthetic sentences. */
const QUESTION = 'Where is the quillon gadget setup page described?';
const QUESTION_ZH = '奎隆小装置的设置页面在哪里说明？';
const DOC_LINK = 'https://doc-only.test/setup';
const CONTEXT_TEXT = `The quillon gadget setup page is described at ${DOC_LINK} in the setup notes.`;
const DOC_ID = '00000000-0000-4000-8000-00000000e331';
const CHUNK_ID = '00000000-0000-4000-8000-00000000e332';

const h = await vi.hoisted(async () => {
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const state = { deltas: ['ok'] as string[] };
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async () => {
        const parts: unknown[] = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't0' }];
        for (const delta of state.deltas) parts.push({ type: 'text-delta', id: 't0', delta });
        parts.push({ type: 'text-end', id: 't0' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
        return { stream: convertArrayToReadableStream(parts as never[]) };
      },
    });
  return {
    state,
    model,
    calls: [] as Array<Record<string, unknown>>,
    guardEvents: [] as Array<{ summary: Record<string, unknown>; context: Record<string, unknown> }>,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) => {
      h.calls.push(params as unknown as Record<string, unknown>);
      return actual.streamText(params);
    },
  };
});
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => h.model(modelId),
}));
vi.mock('@/lib/rag/security/security-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/security/security-events')>()),
  recordOutputGuardEvents: (summary: Record<string, unknown>, context: Record<string, unknown>) => {
    h.guardEvents.push({ summary: { ...summary }, context });
  },
}));

async function seed(db: PGlite): Promise<void> {
  await db.query('INSERT INTO documents (id, filename, content, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
    DOC_ID,
    'quillon-setup.md',
    CONTEXT_TEXT,
    JSON.stringify({ relpath: 'security/quillon-setup.md', language: 'en' }),
    '2025-02-01T00:00:00.000Z',
  ]);
  await db.query(
    'INSERT INTO document_chunks (id, document_id, content, embedding, metadata, created_at) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)',
    [
      CHUNK_ID,
      DOC_ID,
      `Document: quillon-setup.md. Chunk 1 of 1. Content: ${CONTEXT_TEXT}`,
      `[${embedText(QUESTION).join(',')}]`,
      JSON.stringify({ document_title: 'quillon-setup.md', chunk_index: 0, total_chunks: 1 }),
      '2025-02-01T00:00:00.000Z',
    ],
  );
}

const SWITCHES = [
  'RAG_PARTIAL_ANSWER_RULE',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_VERSION_LABELS',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_REGISTRY_TEXTS',
  'RAG_OUTPUT_GUARD',
  'RAG_OUTPUT_LINK_ALLOWLIST',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_EMBED_TENANT',
] as const;
type SwitchName = (typeof SWITCHES)[number];

function setEnv(values: Partial<Record<SwitchName, string>>) {
  for (const name of SWITCHES) delete process.env[name];
  Object.assign(process.env, values);
}

const LANGUAGES = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' } as const;
const RULES = { ...LANGUAGES, RAG_PARTIAL_ANSWER_RULE: 'true', RAG_CONTEXT_RELEVANCE_RULE: 'true' } as const;

function embedRequest(question: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.33', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
}

interface SseChunk {
  type?: string;
  delta?: string;
  errorText?: string;
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

const textOf = (chunks: SseChunk[]) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta ?? '').join('');
const errorOf = (chunks: SseChunk[]) => chunks.find((chunk) => chunk.type === 'error')?.errorText ?? null;

function labels(language: string) {
  return {
    sentinel: NO_ANSWER_SENTINEL,
    not_covered: fixedText('labels.not_covered', language),
    general_knowledge: fixedText('labels.general_knowledge', language),
    from_documents: fixedText('labels.from_documents', language),
    from_web: fixedText('labels.from_web', language),
  };
}

/** The retrieval RPC fails, so the turn takes the knowledge-base-unavailable path whatever the question. */
async function failRetrieval(): Promise<void> {
  const deps = await import('@/lib/rag/deps');
  const request = {
    abortSignal: () => request,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: 'rpc down' } }).then(onFulfilled, onRejected),
  };
  deps.setRagDepsForTests({ adminClient: adminWithRpc({ rpc: () => request } as never, deps.getRagDeps().adminClient) });
}

describe('embed route: answer rules, cap and registry text (05.2-33)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', seed });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.calls.length = 0;
    h.guardEvents.length = 0;
    h.state.deltas = ['ok'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    setEnv({});
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  async function post(request: NextRequest, afterLoad?: () => Promise<void>) {
    const { POST } = await fixture.loadRoute<{ POST: (request: NextRequest) => Promise<Response> }>('embed/chat');
    if (afterLoad) await afterLoad();
    const response = await POST(request);
    return parseSse(await response.text());
  }

  it('all switches off: no rule block, the fixed limit, no transform', async () => {
    setEnv({});
    await post(embedRequest(QUESTION));
    expect(h.calls).toHaveLength(1);
    const system = systemTextOf(h.calls[0]!);
    expect(system).toContain('quillon gadget setup page');
    expect(system).not.toContain('[rule:');
    expect(h.calls[0]!.maxOutputTokens).toBe(2000);
    expect(h.calls[0]!.experimental_transform).toBeUndefined();
  });

  it('relevance and partial-answer switches on: the balanced relevance text and the general-knowledge rule, no strict-only part', async () => {
    setEnv(RULES);
    await post(embedRequest(QUESTION));
    const system = systemTextOf(h.calls[0]!);
    expect(system).toContain(`[rule:relevance]\n${fixedText('instructions.relevance_open', 'en', labels('en'))}`);
    expect(system).toContain(`[rule:general_knowledge]\n${fixedText('instructions.general_knowledge', 'en', labels('en'))}`);
    expect(system).not.toContain('[rule:partial_answer]');
    expect(system).not.toContain('[rule:web_separation]');
    expect(system).not.toContain(NO_ANSWER_SENTINEL);
    expect(system.indexOf('[rule:relevance]')).toBeGreaterThan(system.indexOf('quillon gadget setup page'));
  });

  it('a cap below the fixed limit applies with the concise rule; a larger cap keeps the fixed limit', async () => {
    setEnv({ ...LANGUAGES, RAG_MAX_OUTPUT_TOKENS: '700' });
    await post(embedRequest(QUESTION));
    expect(h.calls[0]!.maxOutputTokens).toBe(700);
    expect(systemTextOf(h.calls[0]!)).toContain(`[rule:concise]\n${fixedText('instructions.concise', 'en')}`);

    h.calls.length = 0;
    setEnv({ ...LANGUAGES, RAG_MAX_OUTPUT_TOKENS: '4000' });
    await post(embedRequest(QUESTION));
    expect(h.calls[0]!.maxOutputTokens).toBe(2000);
  });

  it('registry texts on: the unavailable message is the registry text in the question language', async () => {
    setEnv({ ...LANGUAGES, RAG_REGISTRY_TEXTS: 'true' });
    const chunks = await post(embedRequest(QUESTION_ZH, { 'accept-language': 'en-US,en;q=0.9' }), failRetrieval);
    expect(errorOf(chunks)).toBe(fixedText('notices.kb_unavailable', 'zh'));
    expect(h.calls).toHaveLength(0);
  });

  it('registry texts off: the unavailable message follows the request language as today', async () => {
    setEnv(LANGUAGES);
    const chunks = await post(embedRequest(QUESTION_ZH, { 'accept-language': 'es-ES,es;q=0.9' }), failRetrieval);
    expect(errorOf(chunks)).toBe('La base de conocimiento no está disponible temporalmente. Inténtalo de nuevo en un momento.');
  });

  it('the answer text streams unchanged with every switch off', async () => {
    setEnv({});
    h.state.deltas = ['The setup page is at ', `${DOC_LINK} for details.`];
    expect(textOf(await post(embedRequest(QUESTION)))).toBe(`The setup page is at ${DOC_LINK} for details.`);
    expect(h.guardEvents).toHaveLength(0);
  });
});

describe('embed route: output guard on the stream (05.2-33)', () => {
  let fixture: RouteFixture;
  const GUARD = { ...LANGUAGES, RAG_OUTPUT_LINK_ALLOWLIST: 'allowed.test' } as const;
  const placeholder = () => fixedText('notices.link_removed', 'en');

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', seed });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.calls.length = 0;
    h.guardEvents.length = 0;
    h.state.deltas = ['ok'];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setEnv({});
    vi.restoreAllMocks();
  });

  async function post() {
    const { POST } = await fixture.loadRoute<{ POST: (request: NextRequest) => Promise<Response> }>('embed/chat');
    const response = await POST(embedRequest(QUESTION));
    return parseSse(await response.text());
  }

  it('enforce: a link repeated from a context block is replaced across tokens and recorded for channel embed', async () => {
    setEnv({ ...GUARD, RAG_OUTPUT_GUARD: 'enforce' });
    h.state.deltas = ['The setup page is at https://doc-on', 'ly.test/setup for details.'];
    expect(textOf(await post())).toBe(`The setup page is at ${placeholder()} for details.`);
    expect(Array.isArray(h.calls[0]!.experimental_transform)).toBe(true);
    expect(h.guardEvents).toHaveLength(1);
    const event = h.guardEvents[0]!;
    expect(event.summary).toMatchObject({ mode: 'enforce', links_removed: 1 });
    expect(event.context.channel).toBe('embed');
    expect(event.context.tenantKey).toMatch(/^s:/);
    expect(event.context.removedTargets).toEqual([DOC_LINK]);
    expect((event.context.blocks as Array<{ chunkIds: string[] }>).flatMap((block) => block.chunkIds)).toContain(CHUNK_ID);
    expect(systemTextOf(h.calls[0]!)).toContain('[rule:output_policy]');
  });

  it('enforce: an allowlisted link passes unchanged and records nothing', async () => {
    setEnv({ ...GUARD, RAG_OUTPUT_GUARD: 'enforce' });
    h.state.deltas = ['See https://allowed.test/page for details.'];
    expect(textOf(await post())).toBe('See https://allowed.test/page for details.');
    expect(h.guardEvents).toHaveLength(0);
  });

  it('enforce: a credential request is kept and the warning arrives as a final paragraph of text', async () => {
    setEnv({ ...GUARD, RAG_OUTPUT_GUARD: 'enforce' });
    h.state.deltas = ['Setup is short. ', 'Please enter your password below.'];
    const text = textOf(await post());
    const warning = fixedText('notices.credential_request_warning', 'en');
    expect(text.startsWith('Setup is short. Please enter your password below.')).toBe(true);
    expect(text.endsWith(`\n\n${warning}`)).toBe(true);
    expect(h.guardEvents.map((event) => event.context.channel)).toEqual(['embed']);
  });

  it('flag: the text is unchanged and the finding is recorded', async () => {
    setEnv({ ...GUARD, RAG_OUTPUT_GUARD: 'flag' });
    h.state.deltas = ['The setup page is at https://doc-on', 'ly.test/setup for details.'];
    expect(textOf(await post())).toBe(`The setup page is at ${DOC_LINK} for details.`);
    expect(h.guardEvents).toHaveLength(1);
    expect(h.guardEvents[0]!.summary).toMatchObject({ mode: 'flag', links_removed: 1 });
    expect(h.guardEvents[0]!.context.channel).toBe('embed');
  });
});
