import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeMcpServer {
  baseUrl: string;
  streamableUrl: string;
  sseUrl: string;
  requests: RecordedRequest[];
  toolCalls: { name: string; arguments: unknown }[];
  close: () => Promise<void>;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL = {
  name: 'echo',
  description: 'Echoes its input',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildResult(message: JsonRpcMessage, toolCalls: FakeMcpServer['toolCalls']): unknown {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: (message.params?.protocolVersion as string) ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      };
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call': {
      const params = message.params ?? {};
      toolCalls.push({ name: params.name as string, arguments: params.arguments });
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    }
    default:
      return {};
  }
}

export async function startFakeMcpServer(): Promise<FakeMcpServer> {
  const requests: RecordedRequest[] = [];
  const toolCalls: FakeMcpServer['toolCalls'] = [];
  const sseStreams = new Set<ServerResponse>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: { ...req.headers } });

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const message = JSON.parse(await readBody(req)) as JsonRpcMessage;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: buildResult(message, toolCalls) }));
      return;
    }

    if (url.pathname === '/sse' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: endpoint\ndata: /messages\n\n');
      sseStreams.add(res);
      req.on('close', () => sseStreams.delete(res));
      return;
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const message = JSON.parse(await readBody(req)) as JsonRpcMessage;
      res.writeHead(202).end('Accepted');
      if (message.id !== undefined) {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: buildResult(message, toolCalls) });
        for (const stream of sseStreams) stream.write(`event: message\ndata: ${payload}\n\n`);
      }
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    streamableUrl: `${baseUrl}/mcp`,
    sseUrl: `${baseUrl}/sse`,
    requests,
    toolCalls,
    close: () =>
      new Promise<void>(resolve => {
        for (const stream of sseStreams) stream.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
