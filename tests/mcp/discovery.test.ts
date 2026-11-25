import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextResponse } from 'next/server';
import type { UniversalToolCapability } from '@/lib/mcp/universal-discovery';

const mocks = vi.hoisted(() => ({
  createMCPClient: vi.fn(),
  healthEndpoint: { value: undefined as string | undefined },
  clientApi: {
    discoverAllTools: vi.fn(),
    getConnectionHealth: vi.fn(),
    getConnectionStatus: vi.fn(),
  },
}));

vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: mocks.createMCPClient }));
vi.mock('@/lib/mcp/discovery', () => ({ discoverAllMcpServers: vi.fn(async () => []) }));
vi.mock('@/lib/dev-logger', () => ({
  devLog: { verbose: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/env', () => ({
  env: {
    get MCP_ZAPIER_ENDPOINT() {
      return mocks.healthEndpoint.value;
    },
  },
}));

import { UniversalMcpDiscovery } from '@/lib/mcp/universal-discovery';
import { UniversalMcpClient } from '@/lib/mcp/universal-client';

interface DiscoveryInternals {
  clients: Map<string, unknown>;
  toolCapabilities: Map<string, UniversalToolCapability>;
}

const PLACEHOLDER_ENDPOINT = 'http://127.0.0.1:9/mcp';

const TOOLS = {
  coin_price: { description: 'Look up crypto price data', inputSchema: { type: 'object' } },
  nft_floor: { description: 'Collection floor', inputSchema: { type: 'object' } },
  create_image: { description: 'Make a picture', inputSchema: { type: 'object' } },
  gmail_find_email: { description: 'Find mail', inputSchema: { type: 'object' } },
  plain_tool: { description: 'Does something else', inputSchema: { type: 'object' } },
};

const originalZapierEndpoint = process.env.MCP_ZAPIER_ENDPOINT;

afterAll(() => {
  if (originalZapierEndpoint === undefined) delete process.env.MCP_ZAPIER_ENDPOINT;
  else process.env.MCP_ZAPIER_ENDPOINT = originalZapierEndpoint;
});

describe('UniversalMcpDiscovery client creation', () => {
  beforeEach(() => {
    mocks.createMCPClient.mockReset();
    mocks.createMCPClient.mockImplementation(async () => ({
      tools: async () => TOOLS,
      close: async () => {},
    }));
    process.env.MCP_ZAPIER_ENDPOINT = PLACEHOLDER_ENDPOINT;
  });

  it('creates the MCP client through the imported factory and keeps it in the clients map', async () => {
    const discovery = new UniversalMcpDiscovery();
    const health = await discovery.discoverAllMcpServers();

    expect(health).toHaveLength(1);
    expect(health[0]?.status).toBe('healthy');
    expect(health[0]?.availableTools.sort()).toEqual(Object.keys(TOOLS).sort());

    expect(mocks.createMCPClient).toHaveBeenCalled();
    const config = mocks.createMCPClient.mock.calls[0]?.[0] as {
      transport: { type: string; url: string; headers: Record<string, string> };
    };
    expect(config.transport.url).toBe(PLACEHOLDER_ENDPOINT);
    expect(config.transport.headers.Accept).toBe('application/json, text/event-stream');

    const internals = discovery as unknown as DiscoveryInternals;
    expect(internals.clients.has('zapier')).toBe(true);
  });

  it('creates a client on demand in getServerClient', async () => {
    const discovery = new UniversalMcpDiscovery();
    await discovery.discoverAllMcpServers();
    (discovery as unknown as DiscoveryInternals).clients.clear();
    mocks.createMCPClient.mockClear();

    const client = await discovery.getServerClient('zapier');

    expect(client).not.toBeNull();
    expect(mocks.createMCPClient).toHaveBeenCalledTimes(1);
  });

  it('infers the specific categories and maps the tool schema to parameters', async () => {
    const discovery = new UniversalMcpDiscovery();
    await discovery.discoverAllMcpServers();

    const capabilities = (discovery as unknown as DiscoveryInternals).toolCapabilities;
    expect(capabilities.get('coin_price')?.category).toBe('cryptocurrency');
    expect(capabilities.get('nft_floor')?.category).toBe('nft');
    expect(capabilities.get('create_image')?.category).toBe('creative');
    expect(capabilities.get('gmail_find_email')?.category).toBe('communication');
    expect(capabilities.get('plain_tool')?.category).toBe('unknown');
    expect(capabilities.get('coin_price')?.parameters).toEqual({ type: 'object' });
  });
});

describe('MCP health route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.healthEndpoint.value = PLACEHOLDER_ENDPOINT;
    mocks.clientApi.discoverAllTools.mockReset().mockResolvedValue([{ name: 'echo' }, { name: 'ping' }]);
    mocks.clientApi.getConnectionHealth.mockReset().mockResolvedValue([
      {
        server: 'Zapier',
        connected: true,
        diagnostics: { canConnect: true, canListTools: true, canExecuteTools: true, responseTime: 5, toolCount: 2 },
      },
    ]);
    mocks.clientApi.getConnectionStatus.mockReset().mockReturnValue([{ server: 'Zapier', connected: true }]);
    vi.spyOn(UniversalMcpClient, 'getInstance').mockReturnValue(
      mocks.clientApi as unknown as UniversalMcpClient,
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('connects through the client discovery method and returns its health JSON', async () => {
    vi.doMock('@/lib/admin-route-auth', () => ({ requireAdminOrDeny: async () => null }));
    const { GET } = await import('@/app/api/mcp/health/route');
    const response: NextResponse = await GET(new Request('http://localhost/api/mcp/health'));
    const body = (await response.json()) as {
      overall: string;
      zapier: { diagnostics: { canListTools: boolean; toolCount: number; lastError: string | null } };
      universalClient: { healthDetails: unknown[] };
    };

    expect(mocks.clientApi.discoverAllTools).toHaveBeenCalledTimes(1);
    expect(body.zapier.diagnostics.lastError).toBeNull();
    expect(body.zapier.diagnostics.canListTools).toBe(true);
    expect(body.zapier.diagnostics.toolCount).toBe(2);
    expect(body.universalClient.healthDetails).toHaveLength(1);
    expect(body.overall).toBe('healthy');
    expect(response.status).toBe(200);
  });
});
