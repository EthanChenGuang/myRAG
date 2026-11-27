import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedText } from '@/lib/rag/lang/texts';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const TOOL_MODEL = 'openai/gpt-4.1';
const SMALL_MODEL = 'fixture-org/small-window';
const UNLISTED_MODEL = 'fixture-org/not-in-any-list';
const QUESTION = 'What does the sample note say about item one?';
const CHUNK_TEXT = 'Item one is described in the sample note.';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    retrievals: [] as Array<Record<string, any>>,
    plans: [] as Array<{ input: Record<string, any>; output: Record<string, any> }>,
    finals: [] as Array<{ input: Record<string, any>; output: Record<string, any> }>,
    traces: [] as Array<{ stages: () => Array<Record<string, any>> }>,
    scheduled: [] as Array<Record<string, any>>,
  };
});
const mcp = vi.hoisted(() => ({
  discoverAllTools: vi.fn(async () => []),
  getToolSchema: vi.fn(async () => null),
  executeAnyTool: vi.fn(async () => ({})),
  getEnhancedMcpTools: vi.fn(async () => ({ tools: {}, serverHealth: {}, routingDecisions: [] })),
}));
const cache = vi.hoisted(() => ({ tools: null as Record<string, unknown> | null }));

vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  return {
    ...actual,
    runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
      h.retrievals.push(input as unknown as Record<string, any>);
      return actual.runRetrieval(input);
    },
  };
});
vi.mock('@/lib/rag/context/prompt-budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/context/prompt-budget')>();
  return {
    ...actual,
    planPromptBudget: (input: Parameters<typeof actual.planPromptBudget>[0]) => {
      const output = actual.planPromptBudget(input);
      h.plans.push({ input: input as unknown as Record<string, any>, output: output as unknown as Record<string, any> });
      return output;
    },
    finalizePromptBudget: (...args: Parameters<typeof actual.finalizePromptBudget>) => {
      const output = actual.finalizePromptBudget(...args);
      h.finals.push({ input: args[1] as unknown as Record<string, any>, output: output as unknown as Record<string, any> });
      return output;
    },
  };
});
vi.mock('@/lib/rag/trace/collector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/collector')>();
  return {
    ...actual,
    createTraceCollector: (options: Parameters<typeof actual.createTraceCollector>[0]) => {
      const collector = actual.createTraceCollector(options);
      h.traces.push(collector as never);
      return collector;
    },
  };
});
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: (input: Record<string, any>) => {
    h.scheduled.push(input);
    return Promise.resolve(null);
  },
}));
vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    void task();
  },
}));
vi.mock('@/lib/mcp-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp-cache')>();
  return {
    ...actual,
    getCachedTools: () => (cache.tools ? { tools: cache.tools, timestamp: Date.now(), serverHealth: {} } : null),
  };
});
vi.mock('@/lib/mcp/universal-client', () => ({
  UniversalMcpClient: {
    getInstance: () => ({
      discoverAllTools: mcp.discoverAllTools,
      getToolSchema: mcp.getToolSchema,
      executeAnyTool: mcp.executeAnyTool,
    }),
  },
}));
vi.mock('@/lib/mcp/production-router', () => ({
  productionMcpRouter: { getEnhancedMcpTools: mcp.getEnhancedMcpTools },
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const ENV_NAMES = [
  'RAG_PROMPT_BUDGET',
  'RAG_CONTEXT_TOKEN_BUDGET',
  'RAG_ANSWER_FEEDBACK',
  'NEXT_PUBLIC_OPENROUTER_MODELS',
  'NEXT_PUBLIC_MCP_SYSTEM_ENABLED',
  'MCP_ZAPIER_ENDPOINT',
] as const;

function seed() {
  h.supabase.store.documents = [{ id: 'doc-pb-1', filename: 'note.txt', created_at: '2026-01-01T00:00:00.000Z', content: CHUNK_TEXT, metadata: {} }];
  h.supabase.store.document_chunks = [{ id: 'chunk-pb-1', document_id: 'doc-pb-1', content: CHUNK_TEXT, metadata: {} }];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-pb-1',
        document_id: 'doc-pb-1',
        content: CHUNK_TEXT,
        similarity: 0.9,
        metadata: {},
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.9,
        match_reason: 'similarity',
      },
    ]),
  );
}

function smallWindowModels(contextLength: number) {
  process.env.NEXT_PUBLIC_OPENROUTER_MODELS = JSON.stringify([
    { id: DEFAULT_MODEL, displayName: 'Default', contextLength: 1000000 },
    { id: SMALL_MODEL, displayName: 'Small window', contextLength },
  ]);
}

type Message = { role: string; content: unknown };

interface PostOptions {
  messages?: Message[];
  model?: string;
  data?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

async function post(options: PostOptions = {}) {
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  const response = await POST(
    chatRequest({
      messages: options.messages ?? [{ role: 'user', content: QUESTION }],
      data: {
        ragMode: 'strict',
        settings: { webSearch: false, model: options.model ?? DEFAULT_MODEL, ...(options.settings ?? {}) },
        ...(options.data ?? {}),
      },
    }),
  );
  const body = await readSse(response);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { response, body, params: h.capture.calls[0] };
}

function capture(params: Record<string, any> | undefined) {
  if (!params) return null;
  return {
    messages: JSON.stringify(params.messages),
    tools: Object.keys(params.tools ?? {}).sort(),
    maxOutputTokens: params.maxOutputTokens ?? null,
    providerOptions: JSON.stringify(params.providerOptions ?? null),
  };
}

function retrievalOptions(): Record<string, any> | undefined {
  return h.retrievals.at(-1)?.options;
}

function history(turns: number, words = 40): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push({ role: 'user', content: `Earlier question ${i}: ${'lorem '.repeat(words)}` });
    out.push({ role: 'assistant', content: `Earlier answer ${i}: ${'ipsum '.repeat(words)}` });
  }
  return out;
}

describe('chat route prompt budget (05.2.1-21)', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrievals.length = 0;
    h.plans.length = 0;
    h.finals.length = 0;
    h.traces.length = 0;
    h.scheduled.length = 0;
    cache.tools = null;
    for (const name of ENV_NAMES) delete process.env[name];
    seed();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
    vi.restoreAllMocks();
  });

  describe('plan before retrieval', () => {
    it('plan: switch off passes no documentTokenBudget and the captured request equals an explicit false', async () => {
      const unset = await post({ messages: [...history(2), { role: 'user', content: QUESTION }] });
      const unsetCapture = capture(unset.params);
      expect(retrievalOptions()).toBeDefined();
      expect(retrievalOptions()).not.toHaveProperty('documentTokenBudget');
      h.capture.reset();
      process.env.RAG_PROMPT_BUDGET = 'false';
      const off = await post({ messages: [...history(2), { role: 'user', content: QUESTION }] });

      expect(capture(off.params)).toEqual(unsetCapture);
      expect(retrievalOptions()).not.toHaveProperty('documentTokenBudget');
      expect(h.plans).toHaveLength(0);
      expect(h.finals).toHaveLength(0);
      expect(off.response.headers.get('X-RAG-Error')).toBeNull();
    });

    it('plan: switch on with a known window passes the planner budget, never above RAG_CONTEXT_TOKEN_BUDGET', async () => {
      process.env.RAG_PROMPT_BUDGET = 'true';
      process.env.RAG_CONTEXT_TOKEN_BUDGET = '3000';
      await post();

      expect(h.plans).toHaveLength(1);
      const plan = h.plans[0]!;
      expect(plan.input.window).toBe(1000000);
      expect(plan.input.documentTarget).toBe(3000);
      expect(plan.output.status).toBe('ok');
      expect(retrievalOptions()?.documentTokenBudget).toBe(plan.output.documentBudget);
      expect(retrievalOptions()?.documentTokenBudget).toBe(3000);
    });

    it('plan: a small window lowers the document budget below the target', async () => {
      process.env.RAG_PROMPT_BUDGET = 'true';
      smallWindowModels(12000);
      await post({ model: SMALL_MODEL });

      expect(h.plans).toHaveLength(1);
      const plan = h.plans[0]!;
      expect(plan.input.window).toBe(12000);
      expect(plan.output.documentBudget).toBeLessThan(6000);
      expect(plan.output.documentBudget).toBeGreaterThan(0);
      expect(retrievalOptions()?.documentTokenBudget).toBe(plan.output.documentBudget);
    });

    it('plan: an unlisted model id uses the default window', async () => {
      process.env.RAG_PROMPT_BUDGET = 'true';
      await post({ model: UNLISTED_MODEL });

      expect(h.plans).toHaveLength(1);
      const plan = h.plans[0]!;
      expect(plan.input.window).toBeNull();
      expect(plan.output.trace.window_source).toBe('default');
      expect(plan.output.trace.context_length_unknown).toBe(true);
      expect(typeof retrievalOptions()?.documentTokenBudget).toBe('number');
    });

    it('plan: with MCP enabled the MCP reserve is in the tools part', async () => {
      process.env.RAG_PROMPT_BUDGET = 'true';
      process.env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED = 'true';
      process.env.MCP_ZAPIER_ENDPOINT = 'https://mcp.example.invalid/placeholder';
      (h.supabase.store as Record<string, unknown>).admin_users = [{ id: ADMIN_ID }];
      h.ssr.auth.getUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } }, error: null } as never);
      await post({
        model: TOOL_MODEL,
        messages: [{ role: 'user', content: 'find my latest 3 emails in gmail' }],
        data: { ragMode: 'flexible', sessionId: 'chat-pb-1' },
        settings: { mcpEnabled: true },
      });

      expect(h.plans).toHaveLength(1);
      const plan = h.plans[0]!;
      expect(plan.input.mcpToolReserve).toBe(true);
      expect(plan.output.trace.parts.tools).toBeGreaterThanOrEqual(2000);
      h.ssr.auth.getUser.mockReset();
      h.ssr.auth.getUser.mockResolvedValue({ data: { user: { id: '00000000-0000-4000-8000-000000000001' } }, error: null } as never);
    });

    it('plan: an oversized question gets the in-band prompt_budget_exceeded error; retrieval is not called', async () => {
      process.env.RAG_PROMPT_BUDGET = 'true';
      smallWindowModels(12000);
      const { response, body } = await post({ model: SMALL_MODEL, messages: [{ role: 'user', content: `${QUESTION} ${'lorem '.repeat(12000)}` }] });

      expect(response.headers.get('X-RAG-Error')).toBe('prompt_budget_exceeded');
      expect(body).toContain('"type":"error"');
      expect(body).toContain(JSON.stringify(fixedText('notices.prompt_too_long', 'en')).slice(1, -1));
      expect(body).not.toContain('lorem');
      expect(h.retrievals).toHaveLength(0);
      expect(h.capture.calls).toHaveLength(0);
    });
  });
});
