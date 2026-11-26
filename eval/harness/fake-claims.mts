import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Harness-only stand-in for the sidecar's POST /v1/groundedness/claims (skeleton). Never imported by src/. */
export interface FakeClaimsSidecar {
  url: string;
  secret: string;
  requests: unknown[];
  close(): Promise<void>;
}

export async function startFakeClaimsSidecar(options: { secret?: string } = {}): Promise<FakeClaimsSidecar> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secret: options.secret ?? 'skeleton',
    requests: [],
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
