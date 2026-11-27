import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

let root: string;
let server: http.Server;
let port: number;
let fake: http.Server;
let seen: Array<{ method: string; url: string; body: string }> = [];
let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end('{}');

function call(method: string, url: string, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const origin = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, Origin: origin, 'X-Config-UI': '1' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-term-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env.local'), 'NEXT_PUBLIC_APP_NAME=Demo\n');
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      reply(req, res);
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  process.env.MYRAG_CONFIG_ROOT = root;
  process.env.MYRAG_APP_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const mod = require('../../scripts/config-server.js') as { server: http.Server };
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fake.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
  delete process.env.MYRAG_APP_URL;
});

describe('/api/rag proxy path', () => {
  it('forwards a nested path with its slashes (Express 5 gives the wildcard as an array)', async () => {
    seen = [];
    reply = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true }));
    };
    const res = await call('GET', '/api/rag/admin/terminology/versions?organization_id=c0000000-0000-4000-8000-000000000001');
    expect(res.status).toBe(200);
    expect(seen[0]!.url).toBe('/api/rag/admin/terminology/versions?organization_id=c0000000-0000-4000-8000-000000000001');
  });

  it('still refuses a path that climbs out of /api/rag', async () => {
    seen = [];
    const res = await call('GET', '/api/rag/admin/%2e%2e/%2e%2e/config');
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe('terminology export through the /api/rag proxy', () => {
  it('passes the CSV attachment through with its type, file name, nosniff and no-store', async () => {
    seen = [];
    const csv = 'canonical,variants\n"term alpha beta",termalpha\n';
    reply = (_req, res) => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="terminology-shared-v7.csv"');
      res.end(csv);
    };
    const res = await call('GET', '/api/rag/admin/terminology/export?layer=shared');
    expect(res.status).toBe(200);
    expect(res.body).toBe(csv);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="terminology-shared-v7.csv"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(seen[0]!.url).toBe('/api/rag/admin/terminology/export?layer=shared');
  });

  it('still refuses a non-JSON answer on any other path', async () => {
    reply = (_req, res) => {
      res.setHeader('Content-Type', 'text/csv');
      res.end('a,b\n');
    };
    const res = await call('GET', '/api/rag/admin/terminology?layer=shared');
    expect(res.status).toBe(502);
  });

  it('answers a JSON failure of the export route as JSON', async () => {
    reply = (_req, res) => {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    };
    const res = await call('GET', '/api/rag/admin/terminology/export?layer=shared');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Unauthorized' });
  });
});

describe('terminology import body limit', () => {
  it('forwards an import body over 100 KB (up to the route cap)', async () => {
    seen = [];
    reply = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, report: {} }));
    };
    const csv = 'canonical,variants,language,kind,mode,enabled,note,source_language,target_language\n' + 'term alpha beta,termalpha,any,synonym,one_way,true,,,\n'.repeat(12000);
    const body = JSON.stringify({ layer: 'shared', mode: 'merge', format: 'csv', csv, dry_run: true });
    expect(Buffer.byteLength(body)).toBeGreaterThan(200 * 1024);
    const res = await call('POST', '/api/rag/admin/terminology/import', body);
    expect(res.status).toBe(200);
    expect(JSON.parse(seen[0]!.body).csv).toBe(csv);
  });

  it('keeps the default limit on other paths: a large body never reaches the app', async () => {
    seen = [];
    const body = JSON.stringify({ query: 'x'.repeat(200 * 1024) });
    const res = await call('POST', '/api/rag/admin/terminology/preview', body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(0);
  });
});
