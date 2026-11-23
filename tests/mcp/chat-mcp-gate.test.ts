import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, emptyRetrieval, readSse } from '../helpers/chat-route-fakes';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

const mcp = vi.hoisted(() => ({
  discoverAllTools: vi.fn(async () => []),
  getToolSchema: vi.fn(async () => null),
  executeAnyTool: vi.fn(async () => ({})),
  getEnhancedMcpTools: vi.fn(async () => ({ tools: {}, serverHealth: {}, routingDecisions: [] })),
  generateImage: vi.fn(),
  fetch: vi.fn(),
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
vi.mock('@/app/api/generate-image/route', () => ({ POST: mcp.generateImage }));

const QUERY = 'find my latest emails in gmail';

async function loadRoute() {
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

function signIn(userId: string | null) {
  h.ssr.auth.getUser.mockResolvedValue({ data: { user: userId ? { id: userId } : null }, error: null } as never);
}

function mcpRequest(settings: Record<string, unknown> = { mcpEnabled: true }) {
  return chatRequest({
    messages: [{ role: 'user', content: QUERY }],
    data: { sessionId: 'chat-1', ragMode: 'flexible', settings },
  });
}

describe('chat route MCP gate', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    for (const fn of [mcp.discoverAllTools, mcp.getToolSchema, mcp.executeAnyTool, mcp.getEnhancedMcpTools, mcp.generateImage]) {
      fn.mockClear();
    }
    (h.supabase.store as Record<string, unknown>).admin_users = [{ id: ADMIN_ID }];
    process.env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED = 'true';
    process.env.MCP_ZAPIER_ENDPOINT = 'https://mcp.example.invalid/placeholder';
    delete process.env.NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED;
    signIn(USER_ID);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED;
    delete process.env.MCP_ZAPIER_ENDPOINT;
    delete process.env.NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED;
    vi.restoreAllMocks();
  });

  it('never plans MCP tools for a signed-in non-admin who sends mcpEnabled: true', async () => {
    const { POST } = await loadRoute();
    await readSse(await POST(mcpRequest()));
    expect(mcp.discoverAllTools).not.toHaveBeenCalled();
    expect(mcp.getEnhancedMcpTools).not.toHaveBeenCalled();
    expect(h.capture.calls.every((call) => !Object.keys(call.tools ?? {}).some((name) => name !== 'useDocument' && name !== 'webSearch'))).toBe(true);
  });

  it('never plans MCP tools for a non-admin when the request omits mcpEnabled', async () => {
    const { POST } = await loadRoute();
    await readSse(await POST(mcpRequest({})));
    expect(mcp.discoverAllTools).not.toHaveBeenCalled();
  });

  it('never plans MCP tools for an anonymous caller, even with YOLO enabled', async () => {
    process.env.NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED = 'true';
    signIn(null);
    const { POST } = await loadRoute();
    await readSse(await POST(mcpRequest()));
    expect(mcp.discoverAllTools).not.toHaveBeenCalled();
    expect(mcp.getEnhancedMcpTools).not.toHaveBeenCalled();
    expect(mcp.executeAnyTool).not.toHaveBeenCalled();
  });

  it('refuses MCP when the admin lookup fails', async () => {
    (h.supabase.store as Record<string, unknown>).admin_users = undefined;
    const original = h.supabase.client.from.getMockImplementation();
    h.supabase.client.from.mockImplementation(((table: string) => {
      if (table === 'admin_users') throw new Error('db down');
      return original?.(table);
    }) as never);
    const { POST } = await loadRoute();
    await readSse(await POST(mcpRequest()));
    expect(mcp.discoverAllTools).not.toHaveBeenCalled();
    h.supabase.client.from.mockImplementation(original as never);
  });

  it('still plans MCP tools for a verified admin', async () => {
    signIn(ADMIN_ID);
    const { POST } = await loadRoute();
    await readSse(await POST(mcpRequest()));
    expect(mcp.discoverAllTools).toHaveBeenCalled();
    expect(mcp.getEnhancedMcpTools).toHaveBeenCalled();
    const scopeKey = (mcp.getEnhancedMcpTools.mock.calls[0] as unknown[])[3] as string;
    expect(scopeKey).toBe(`${ADMIN_ID}::chat-1`);
    const cache = (globalThis as unknown as { mcpToolsCache: Map<string, unknown> }).mcpToolsCache;
    expect(cache.has(scopeKey)).toBe(true);
    expect(cache.has('chat-1')).toBe(false);
  });
});

describe('chat route image-edit self call', () => {
  beforeEach(() => {
    h.capture.reset();
    mcp.generateImage.mockReset();
    mcp.fetch.mockReset();
    signIn(USER_ID);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls generation in-process and never fetches an Origin-derived host', async () => {
    vi.stubGlobal('fetch', mcp.fetch);
    mcp.generateImage.mockResolvedValue(
      new Response(JSON.stringify({ images: ['https://img.example.invalid/out.png'] }), { status: 200 }),
    );
    const { POST } = await loadRoute();
    const request = chatRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'make this brighter' },
            { type: 'image_url', image_url: { url: 'https://img.example.invalid/in.png' } },
          ],
        },
      ],
      data: { sessionId: 'chat-1', settings: {} },
    });
    const spoofed = new Request(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid', cookie: 'sb=placeholder' },
      body: JSON.stringify(await request.clone().json()),
    });
    await POST(spoofed as never);
    expect(mcp.generateImage).toHaveBeenCalledTimes(1);
    for (const call of mcp.fetch.mock.calls) {
      expect(String(call[0])).not.toContain('attacker.invalid');
    }
    const forwarded = mcp.generateImage.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).hostname).toBe('localhost');
    expect(forwarded.headers.get('cookie')).toBeNull();
  });
});
