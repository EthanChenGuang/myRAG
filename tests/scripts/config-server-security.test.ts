import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

let root: string;
let server: http.Server;
let port: number;

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function call(
  method: string,
  url: string,
  options: { host?: string; headers?: Record<string, string>; body?: Buffer | string; ui?: boolean } = {},
): Promise<Reply> {
  const origin = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {
    Host: options.host ?? `127.0.0.1:${port}`,
    ...(options.ui === false ? {} : { Origin: origin, 'X-Config-UI': '1' }),
    ...(options.headers ?? {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function multipart(fields: Record<string, string>, file: { field: string; name: string; data: Buffer }) {
  const boundary = '----configtest';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-server-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.env.local'),
    [
      'NEXT_PUBLIC_APP_NAME=Demo',
      'SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role',
      'OPENAI_API_KEY=placeholder-openai',
      'MCP_ZAPIER_ENDPOINT=https://hooks.example.test/placeholder-path',
      'MCP_CUSTOM_SERVERS=[{"endpoint":"https://x.example.test","authentication":{"credentials":{"token":"placeholder-token"}}}]',
      'DATABASE_URL=postgres://user:placeholder-pw@db.example.test/app',
      '',
    ].join('\n'),
  );
  process.env.MYRAG_CONFIG_ROOT = root;
  const mod = require('../../scripts/config-server.js') as { server: http.Server; HOST: string };
  expect(mod.HOST).toBe('127.0.0.1');
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
});

describe('config server binds loopback by default', () => {
  it('start() listens on 127.0.0.1 unless CONFIG_UI_HOST says otherwise', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/config-server.js'), 'utf8');
    expect(source).toContain("process.env.CONFIG_UI_HOST || '127.0.0.1'");
    expect(source).toContain('server.listen(PORT, HOST');
    expect(source).not.toMatch(/server\.listen\(PORT, \(\) =>/);
  });
});

describe('Host header (DNS rebinding)', () => {
  it.each(['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example'])('answers 403 to Host %s', async (host) => {
    for (const value of [host, `${host}:${port}`]) {
      const reply = await call('GET', '/api/config', { host: value });
      expect(reply.status).toBe(403);
      expect(reply.body).not.toContain('placeholder');
    }
  });

  it('answers 403 to a loopback Host with another port', async () => {
    expect((await call('GET', '/api/config', { host: '127.0.0.1:9999' })).status).toBe(403);
  });

  it('serves localhost and 127.0.0.1 on the real port', async () => {
    expect((await call('GET', '/api/config', { host: `localhost:${port}` })).status).toBe(200);
    expect((await call('GET', '/api/config', { host: `127.0.0.1:${port}` })).status).toBe(200);
  });
});

describe('GET /api/config never returns secret values', () => {
  it('returns non-secret values and lists which secrets are set', async () => {
    const reply = await call('GET', '/api/config');
    expect(reply.status).toBe(200);
    for (const secret of ['placeholder-service-role', 'placeholder-openai', 'placeholder-path', 'placeholder-token', 'placeholder-pw']) {
      expect(reply.body).not.toContain(secret);
    }
    const data = JSON.parse(reply.body) as { config: Record<string, string>; secretsSet: string[] };
    expect(data.config.NEXT_PUBLIC_APP_NAME).toBe('Demo');
    expect(data.config.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(data.secretsSet).toEqual(
      expect.arrayContaining(['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'MCP_ZAPIER_ENDPOINT', 'MCP_CUSTOM_SERVERS', 'DATABASE_URL']),
    );
  });

  it('get-env refuses a secret name and does not echo its value', async () => {
    const reply = await call('GET', '/api/config/get-env?var=OPENAI_API_KEY');
    expect(reply.status).toBe(403);
    expect(reply.body).not.toContain('placeholder');
    expect((await call('GET', '/api/config/get-env?var=NEXT_PUBLIC_APP_NAME')).body).toContain('Demo');
  });

  it('saving without touching a secret leaves it unchanged, and an empty secret never wipes it', async () => {
    const reply = await call('POST', '/api/config', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { NEXT_PUBLIC_APP_NAME: 'Renamed', OPENAI_API_KEY: '' } }),
    });
    expect(reply.status).toBe(200);
    const written = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
    expect(written).toContain('NEXT_PUBLIC_APP_NAME=Renamed');
    expect(written).toContain('OPENAI_API_KEY=placeholder-openai');
    expect(written).toContain('SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role');
  });

  it('a new secret value is written', async () => {
    const reply = await call('POST', '/api/config', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { NEXT_PUBLIC_APP_NAME: 'Renamed', OPENAI_API_KEY: 'placeholder-rotated' } }),
    });
    expect(reply.status).toBe(200);
    expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).toContain('OPENAI_API_KEY=placeholder-rotated');
  });

  it('a carriage return or NUL in a value answers 400 and writes nothing', async () => {
    const before = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
    const reply = await call('POST', '/api/config', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { NEXT_PUBLIC_APP_NAME: 'x\rNEXT_PUBLIC_SUPABASE_URL=https://attacker' } }),
    });
    expect(reply.status).toBe(400);
    expect(fs.readFileSync(path.join(root, '.env.local'), 'utf8')).toBe(before);
  });

  it('a newline in a value is stored as the literal backslash-n and never starts a new line', async () => {
    const reply = await call('POST', '/api/config', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { NEXT_PUBLIC_APP_NAME: 'one\nNEXT_PUBLIC_SUPABASE_URL=https://attacker' } }),
    });
    expect(reply.status).toBe(200);
    const written = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
    expect(written.split('\n').some((line) => line.startsWith('NEXT_PUBLIC_SUPABASE_URL='))).toBe(false);
  });
});

describe('CSRF', () => {
  const body = JSON.stringify({ config: { NEXT_PUBLIC_APP_NAME: 'Hijacked' } });
  const json = { 'Content-Type': 'application/json' };

  it('refuses a cross-origin POST even with the custom header', async () => {
    const reply = await call('POST', '/api/config', { headers: { ...json, Origin: 'https://evil.example' }, body });
    expect(reply.status).toBe(403);
  });

  it('refuses a same-origin POST without the custom header (a cross-site form cannot send it)', async () => {
    const reply = await call('POST', '/api/config', { headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body, ui: false });
    expect(reply.status).toBe(403);
  });

  it('refuses a POST with neither Origin nor Referer', async () => {
    const reply = await call('POST', '/api/config', { headers: { ...json, 'X-Config-UI': '1' }, body, ui: false });
    expect(reply.status).toBe(403);
  });

  it('accepts a Referer from this origin when Origin is absent', async () => {
    const reply = await call('POST', '/api/config', {
      headers: { ...json, 'X-Config-UI': '1', Referer: `http://127.0.0.1:${port}/index.html` },
      body,
      ui: false,
    });
    expect(reply.status).toBe(200);
  });

  it('refuses a cross-origin multipart upload form post and writes nothing', async () => {
    const form = multipart({}, { field: 'favicon', name: 'favicon.png', data: PNG });
    const reply = await call('POST', '/api/config/upload-favicon', {
      headers: { ...form.headers, Origin: 'https://evil.example' },
      body: form.body,
      ui: false,
    });
    expect(reply.status).toBe(403);
    expect(filesUnder(path.join(root, 'public'))).toEqual([]);
  });

  it('answers 403 to a preflight', async () => {
    const reply = await call('OPTIONS', '/api/config', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }, ui: false });
    expect(reply.status).toBe(403);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('uploads', () => {
  it('stores a real PNG favicon under a fixed name', async () => {
    const form = multipart({}, { field: 'favicon', name: 'whatever.png', data: PNG });
    const reply = await call('POST', '/api/config/upload-favicon', { headers: form.headers, body: form.body });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).url).toBe('/favicon.png');
    expect(fs.readFileSync(path.join(root, 'public', 'favicon.png')).equals(PNG)).toBe(true);
  });

  it.each([
    ['favicon.html', HTML],
    ['favicon.svg', SVG],
    ['favicon.png', SVG],
    ['favicon.png.html', PNG],
    ['favicon.ico', PNG],
  ])('refuses favicon %s', async (name, data) => {
    const before = filesUnder(path.join(root, 'public')).sort();
    const form = multipart({}, { field: 'favicon', name, data });
    const reply = await call('POST', '/api/config/upload-favicon', { headers: form.headers, body: form.body });
    expect(reply.status).toBe(400);
    expect(filesUnder(path.join(root, 'public')).sort()).toEqual(before);
  });

  it.each(['../../src', '../x', 'header/../../..', 'other', ''])('refuses logo type %j without writing', async (type) => {
    const before = filesUnder(root).sort();
    const form = multipart(type === '' ? {} : { type }, { field: 'logoFile', name: 'logo.png', data: PNG });
    const reply = await call('POST', '/api/config/upload-logo', { headers: form.headers, body: form.body });
    expect(reply.status).toBe(type === '' ? 200 : 400);
    if (type !== '') expect(filesUnder(root).sort()).toEqual(before);
  });

  it('stores a PNG logo under a server-chosen name in the allowed folder', async () => {
    const form = multipart({ type: 'header' }, { field: 'logoFile', name: '../../evil.png', data: PNG });
    const reply = await call('POST', '/api/config/upload-logo', { headers: form.headers, body: form.body });
    expect(reply.status).toBe(200);
    const filePath = JSON.parse(reply.body).filePath as string;
    expect(filePath).toMatch(/^\/logos\/header\/header-logo-\d+\.png$/);
    expect(fs.existsSync(path.join(root, 'public', filePath))).toBe(true);
  });

  it('refuses an SVG logo', async () => {
    const form = multipart({ type: 'ai' }, { field: 'logoFile', name: 'logo.svg', data: SVG });
    const reply = await call('POST', '/api/config/upload-logo', { headers: form.headers, body: form.body });
    expect(reply.status).toBe(400);
  });
});

describe('main app proxy target (ME-01)', () => {
  async function withFakeApp<T>(run: (app: { port: number; seen: http.IncomingHttpHeaders[] }) => Promise<T>): Promise<T> {
    const seen: http.IncomingHttpHeaders[] = [];
    const fake = http.createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ preContext: 'p', postContext: 'q', assembledPrompt: 'p {{context}} q' }));
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    try {
      return await run({ port: (fake.address() as AddressInfo).port, seen });
    } finally {
      await new Promise((resolve) => fake.close(resolve));
    }
  }

  it('forwards the UI cookies only to MYRAG_APP_URL, never to NEXT_PUBLIC_SITE_URL from the env file', async () => {
    const envPath = path.join(root, '.env.local');
    const original = fs.readFileSync(envPath, 'utf8');
    fs.writeFileSync(envPath, `${original}NEXT_PUBLIC_SITE_URL=http://127.0.0.1:1\n`);
    process.env.NEXT_PUBLIC_SITE_URL = 'http://127.0.0.1:1';
    try {
      await withFakeApp(async (app) => {
        process.env.MYRAG_APP_URL = `http://127.0.0.1:${app.port}`;
        const reply = await call('GET', '/api/config/rag-prompt', { headers: { Cookie: 'sb-session=placeholder-session' } });
        expect(reply.status).toBe(200);
        expect(app.seen).toHaveLength(1);
        expect(app.seen[0].cookie).toBe('sb-session=placeholder-session');
      });
    } finally {
      delete process.env.MYRAG_APP_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      fs.writeFileSync(envPath, original);
    }
  });

  it('without MYRAG_APP_URL the target is localhost:3000, not NEXT_PUBLIC_SITE_URL', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/config-server.js'), 'utf8');
    const start = source.indexOf('function getMainAppBaseUrl');
    const body = source.slice(start, source.indexOf('}', source.indexOf('return normalizeBaseUrl', start)));
    expect(body).toContain("'http://localhost:3000'");
    expect(body).not.toContain('NEXT_PUBLIC_SITE_URL');
  });
});
