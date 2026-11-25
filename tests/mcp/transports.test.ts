import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeMcpServer, type FakeMcpServer } from './helpers/fake-mcp-server';
import { TransportFactory, type McpTransport } from '@/lib/mcp/transport-factory';
import type { McpServerConfig } from '@/lib/mcp/server-config';

const PLACEHOLDER_HEADER = 'x-test-placeholder';
const PLACEHOLDER_VALUE = 'placeholder-value';

let fake: FakeMcpServer;

beforeAll(async () => {
  fake = await startFakeMcpServer();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.toolCalls.length = 0;
});

function configFor(type: 'sse' | 'streamable-http'): McpServerConfig {
  return {
    id: `fake-${type}`,
    name: `fake-${type}`,
    endpoint: type === 'sse' ? fake.sseUrl : fake.streamableUrl,
    transport: { type, headers: { [PLACEHOLDER_HEADER]: PLACEHOLDER_VALUE } },
  };
}

const MEMBERS: (keyof McpTransport)[] = [
  'connect',
  'disconnect',
  'sendMessage',
  'onMessage',
  'onError',
  'onClose',
  'isConnected',
  'listTools',
  'executeTool',
  'getClient',
  'getSdkTransport',
];

describe.each(['streamable-http', 'sse'] as const)('%s transport', type => {
  it('satisfies the McpTransport interface from the factory', () => {
    const transport = TransportFactory.getInstance().createTransport(configFor(type));
    for (const member of MEMBERS) {
      expect(typeof transport[member], `member ${member}`).toBe('function');
    }
    expect(transport.getClient()).toBeNull();
    expect(transport.getSdkTransport()).toBeNull();
  });

  it('connects, lists one tool, executes it and closes', async () => {
    const transport = TransportFactory.getInstance().createTransport(configFor(type));
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    expect(transport.getClient()).not.toBeNull();
    expect(transport.getSdkTransport()).not.toBeNull();

    const tools: unknown = await transport.listTools();
    const names = Array.isArray(tools)
      ? (tools as { name: string }[]).map(tool => tool.name)
      : Object.keys(tools as Record<string, unknown>);
    expect(names).toEqual(['echo']);

    await transport.executeTool('echo', { text: 'hi' });
    expect(fake.toolCalls).toEqual([{ name: 'echo', arguments: { text: 'hi' } }]);

    await transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  it('sends the configured custom headers to the server', async () => {
    const transport = TransportFactory.getInstance().createTransport(configFor(type));
    await transport.connect();
    await transport.listTools();
    await transport.disconnect();

    const values = fake.requests.map(request => request.headers[PLACEHOLDER_HEADER]);
    expect(values.length).toBeGreaterThan(1);
    expect(values.every(value => value === PLACEHOLDER_VALUE)).toBe(true);
  });
});
