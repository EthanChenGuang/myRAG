import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';
const TOOL_MODEL = 'openai/gpt-4.1';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const QUANTITY_QUESTION = 'What is 3 times 4 for item one?';
const PLAIN_QUESTION = 'zzzz';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

const spy = vi.hoisted(() => ({ transformParts: [] as Array<Record<string, unknown>> }));
const mcp = vi.hoisted(() => ({
  discoverAllTools: vi.fn(async () => []),
  getToolSchema: vi.fn(async () => null),
  executeAnyTool: vi.fn(async () => ({})),
  getEnhancedMcpTools: vi.fn(async () => ({ tools: {}, serverHealth: {}, routingDecisions: [] })),
}));
const cache = vi.hoisted(() => ({ tools: null as Record<string, unknown> | null }));

// Plan 05.2.1-02 adds calcTool to the answer-config reader; until it lands it is read here from the same env name.
vi.mock('@/lib/rag/generation/answer-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/generation/answer-config')>();
  return {
    ...actual,
    readAnswerConfig: (source: Record<string, string | undefined> = process.env) => ({
      ...actual.readAnswerConfig(source),
      calcTool: source.RAG_CALC_TOOL === 'true',
      calcCheck: source.RAG_CALC_CHECK === 'true',
    }),
  };
});
vi.mock('@/lib/rag/generation/answer-transforms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/generation/answer-transforms')>();
  return {
    ...actual,
    buildAnswerTransforms: (parts: Parameters<typeof actual.buildAnswerTransforms>[0]) => {
      spy.transformParts.push(parts as unknown as Record<string, unknown>);
      return actual.buildAnswerTransforms(parts);
    },
  };
});
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

function seedDocument() {
  h.supabase.store.documents = [
    { id: 'doc-calc-1', filename: 'values.txt', created_at: '2026-01-01T00:00:00.000Z', content: 'Item one has value 12 units.', metadata: {} },
  ];
  h.supabase.store.document_chunks = [{ id: 'chunk-calc-1', document_id: 'doc-calc-1', content: 'Item one has value 12 units.', metadata: {} }];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-calc-1',
        document_id: 'doc-calc-1',
        content: 'Item one has value 12 units.',
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

async function loadRoute() {
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

interface PostOptions {
  question?: string;
  model?: string;
  capabilities?: Record<string, unknown>;
  ragMode?: string;
  settings?: Record<string, unknown>;
  sessionId?: string;
}

async function post(options: PostOptions = {}) {
  const { POST } = await loadRoute();
  const data: Record<string, unknown> = {
    ragMode: options.ragMode ?? 'strict',
    settings: { webSearch: false, model: options.model ?? TOOL_MODEL, ...(options.settings ?? {}) },
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };
  const body = await readSse(await POST(chatRequest({ messages: [{ role: 'user', content: options.question ?? QUANTITY_QUESTION }], data })));
  return { params: h.capture.calls[0], body };
}

function systemText(params: Record<string, any>): string {
  return (params.messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n\n');
}

function capture(params: Record<string, any>) {
  return {
    tools: Object.keys(params.tools ?? {}).sort(),
    toolChoice: params.toolChoice ?? null,
    messages: JSON.stringify(params.messages),
    transform: Array.isArray(params.experimental_transform) ? params.experimental_transform.length : null,
  };
}

function lastCalcBlock(): unknown {
  return spy.transformParts.at(-1)?.calcBlock;
}

describe('chat route calculation offer (05.2.1-14)', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    spy.transformParts.length = 0;
    cache.tools = null;
    delete process.env.RAG_CALC_TOOL;
    delete process.env.RAG_CITATIONS;
    seedDocument();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.RAG_CALC_TOOL;
    delete process.env.RAG_CITATIONS;
    delete process.env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED;
    delete process.env.MCP_ZAPIER_ENDPOINT;
    vi.restoreAllMocks();
  });

  it('with the switch off the captured stream parameters equal an explicit false, and nothing calculation-related is present', async () => {
    const unset = capture((await post()).params);
    h.capture.reset();
    process.env.RAG_CALC_TOOL = 'false';
    const off = capture((await post()).params);

    expect(off).toEqual(unset);
    expect(off.tools).not.toContain('calculate');
    expect(off.messages).not.toContain('[rule:calculation]');
    expect(off.messages).not.toContain('[S1]');
    expect(lastCalcBlock()).toBeUndefined();
  });

  it('with the switch on, a quantity question on a tool model gets the calculate tool and the tool instruction', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    const { params } = await post();

    expect(Object.keys(params.tools ?? {})).toEqual(expect.arrayContaining(['useDocument', 'calculate']));
    expect(params.toolChoice).toBe('auto');
    const system = systemText(params);
    expect(system).toContain('[rule:calculation]');
    expect(system).not.toContain(CALC_BLOCK_OPEN);
    expect(system).toContain('[S1]');
  });

  it('with the switch on, the default model gets no tool, the trailing-block instruction and the block transform', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    const { params } = await post({ model: DEFAULT_MODEL });

    expect(Object.keys(params.tools ?? {})).not.toContain('calculate');
    const system = systemText(params);
    expect(system).toContain('[rule:calculation]');
    expect(system).toContain(CALC_BLOCK_OPEN);
    const block = lastCalcBlock() as { onTrace?: unknown; stripMarkers?: boolean } | undefined;
    expect(block).toBeDefined();
    expect(typeof block?.onTrace).toBe('function');
    expect(block?.stripMarkers).toBe(true);
  });

  it('with the switch on, a question without quantity or intent term changes nothing', async () => {
    const off = capture((await post({ question: PLAIN_QUESTION })).params);
    h.capture.reset();
    spy.transformParts.length = 0;
    process.env.RAG_CALC_TOOL = 'true';
    const on = capture((await post({ question: PLAIN_QUESTION })).params);

    // 05.2.1-02 counts RAG_CALC_TOOL in anyNonDefault, so the switch alone installs the Phase 5.2 notice collector (its transforms
    // pass text through unchanged); nothing calculation-related reaches the call: no tool, no instruction, no block, no check slot.
    const { transform: onTransform, ...onRest } = on;
    const { transform: offTransform, ...offRest } = off;
    expect(onRest).toEqual(offRest);
    expect(offTransform).toBeNull();
    expect(onTransform).toBeGreaterThan(0);
    expect(spy.transformParts.at(-1)?.calcCheck).toBeUndefined();
    expect(lastCalcBlock()).toBeUndefined();
  });

  it('without the citations capability, a quantity question still labels the blocks and strips markers from the visible text', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    const { params } = await post();

    expect(systemText(params)).toContain('[S1]');
    const block = lastCalcBlock() as { onTrace?: unknown; stripMarkers?: boolean } | undefined;
    expect(block?.stripMarkers).toBe(true);
    expect(block?.onTrace).toBeUndefined();
  });

  it('with the citations capability and RAG_CITATIONS on, tool mode keeps the markers for the citation parser', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_CITATIONS = 'true';
    const { params, body } = await post({ capabilities: { citations: true } });

    expect(Object.keys(params.tools ?? {})).toContain('calculate');
    expect(systemText(params)).toContain('[S1]');
    expect(lastCalcBlock()).toBeUndefined();
    expect(body).toContain('"citationStrategy":"chunk-alias"');
  });

  it('a calculation turn on a Claude Citations model takes the chunk-alias path', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_CITATIONS = 'true';
    process.env.RAG_CLAUDE_CITATIONS = 'true';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-placeholder';
    try {
      const { body } = await post({ model: 'anthropic/claude-sonnet-5.5', capabilities: { citations: true } });
      expect(body).not.toContain('"citationStrategy":"claude-citations"');
    } finally {
      delete process.env.RAG_CLAUDE_CITATIONS;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('does not register calculate over an MCP tool of the same name and logs one [Calc] line without text', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED = 'true';
    process.env.MCP_ZAPIER_ENDPOINT = 'https://mcp.example.invalid/placeholder';
    (h.supabase.store as Record<string, unknown>).admin_users = [{ id: ADMIN_ID }];
    h.ssr.auth.getUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } }, error: null } as never);
    cache.tools = { calculate: { description: 'external calculator', parameters: undefined } };

    const { params } = await post({
      question: 'find my latest 3 emails in gmail',
      ragMode: 'flexible',
      settings: { mcpEnabled: true },
      sessionId: 'chat-calc-1',
    });

    const tools = params.tools as Record<string, unknown>;
    expect(Object.keys(tools)).toContain('calculate');
    const { isServerCalculateTool } = await import('@/lib/rag/generation/calc-tool');
    expect(isServerCalculateTool(tools.calculate)).toBe(false);
    const calcLines = vi
      .mocked(console.log)
      .mock.calls.filter((args) => args[0] === '[Calc]' && JSON.stringify(args).includes('name_collision'));
    expect(calcLines).toHaveLength(1);
    expect(JSON.stringify(calcLines)).not.toContain('gmail');
  });
});
