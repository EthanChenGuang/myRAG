import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpTransport } from '@/lib/mcp/transport-factory';

const createMCPClient = vi.fn();

vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: (config: unknown) => createMCPClient(config) }));
vi.mock('@/lib/mcp/discovery', () => ({ discoverAllMcpServers: vi.fn(async () => []) }));

import { UniversalMcpClient } from '@/lib/mcp/universal-client';

interface ClientInternals {
  mcpTransports: Map<string, McpTransport>;
}

function stubTransport(sdkTransport: object): McpTransport {
  return {
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async () => {},
    onMessage: () => {},
    onError: () => {},
    onClose: () => {},
    isConnected: () => true,
    listTools: async () => ({}),
    executeTool: async () => ({}),
    getClient: () => null,
    getSdkTransport: () => sdkTransport,
  };
}

describe('UniversalMcpClient.getAiSdkTools', () => {
  beforeEach(() => {
    createMCPClient.mockReset();
    UniversalMcpClient.resetInstance();
  });

  it('awaits the AI SDK client before reading its tools', async () => {
    const sdkTransport = { start: async () => {} };
    const aiTool = { description: 'Echo tool' };
    createMCPClient.mockImplementation(async () => ({ tools: async () => ({ echo: aiTool }) }));

    const client = UniversalMcpClient.getInstance();
    (client as unknown as ClientInternals).mcpTransports.set('fake', stubTransport(sdkTransport));

    const tools = await client.getAiSdkTools();

    expect(createMCPClient).toHaveBeenCalledWith({ transport: sdkTransport });
    expect(tools).toEqual({ echo: aiTool });
  });
});
