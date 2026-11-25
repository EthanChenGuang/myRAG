import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';

export type IngestRouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string; action?: string }> },
) => Promise<Response>;

export interface IngestAppServer {
  url: string;
  close(): Promise<void>;
}

export async function startIngestAppServer(
  routes: Record<string, IngestRouteHandler>,
): Promise<IngestAppServer> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const match = /^\/api\/internal\/rag\/ingest\/jobs\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (method !== 'POST' || !match) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const [, id, action] = match;
        const handler = routes[action];
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unknown action' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
          else headers.set(name, value);
        }

        const request = new NextRequest(url, { method, headers, body: body.length ? body : undefined });
        const response = await handler(request, { params: Promise.resolve({ id, action }) });

        const outBody = Buffer.from(await response.arrayBuffer());
        const outHeaders: Record<string, string | string[]> = {};
        response.headers.forEach((value, key) => {
          outHeaders[key] = value;
        });
        res.writeHead(response.status, outHeaders);
        res.end(outBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}