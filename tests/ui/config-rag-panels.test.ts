import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOC_TYPE_CHOICES, docTypeLabel } from '@/components/ui/doc-type-labels';

const require = createRequire(import.meta.url);

interface StubCapture {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
}

function loadRagFetch() {
  return require('../../scripts/config-ui/rag-panels/rag-fetch.js') as {
    authMessage: (status: number, appUrl?: string) => string;
    buildRagFetchInit: (apiPath: string, init?: RequestInit) => { url: string; init: RequestInit };
    ragFetch: (apiPath: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; message?: string; body: unknown }>;
  };
}

function loadDocTypes() {
  return require('../../scripts/config-ui/rag-panels/doc-types.js') as {
    CONFIG_UI_DOC_TYPE_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
    buildUploadForm: (file: File, docType: string, pickerEnabled: boolean) => FormData;
    docTypeLabelForLocale: (id: string, locale: 'en' | 'zh' | 'it') => string;
  };
}

function loadQuarantine() {
  return require('../../scripts/config-ui/rag-panels/quarantine.js') as {
    buildQuarantineItemView: (item: Record<string, unknown>) => { filename: string; ruleIds: string; snippets: string[] };
  };
}

function loadEmbeddingProfiles() {
  return require('../../scripts/config-ui/rag-panels/embedding-profiles.js') as {
    formatActivationRefusal: (body: { reason?: string; error?: string }) => string;
    buildProfileRowView: (profile: Record<string, unknown>) => { id: string; summary: string; evidence: string };
  };
}

describe('RAG panel helpers', () => {
  it('authMessage points to the main app for 401 and 403 and retries on 503', () => {
    const { authMessage } = loadRagFetch();
    const app = 'http://localhost:3000';
    expect(authMessage(401, app)).toContain(app);
    expect(authMessage(401, app)).toMatch(/sign in/i);
    expect(authMessage(403, app)).toContain(app);
    expect(authMessage(503, app)).toMatch(/retry/i);
  });

  it('buildRagFetchInit uses same-origin credentials and does not add Authorization', () => {
    const { buildRagFetchInit } = loadRagFetch();
    const { url, init } = buildRagFetchInit('admin/quarantine', { method: 'GET' });
    expect(url).toBe('/api/rag/admin/quarantine');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('Config UI label table matches doc-type-labels.ts for zh, en and it', () => {
    const { CONFIG_UI_DOC_TYPE_LABELS, docTypeLabelForLocale } = loadDocTypes();
    for (const locale of ['en', 'zh', 'it'] as const) {
      for (const id of DOC_TYPE_CHOICES) {
        expect(docTypeLabelForLocale(id, locale)).toBe(docTypeLabel(id, locale));
        expect(CONFIG_UI_DOC_TYPE_LABELS[locale][id]).toBe(docTypeLabel(id, locale));
      }
    }
  });

  it('buildUploadForm omits doc_type when the picker is disabled', () => {
    const { buildUploadForm } = loadDocTypes();
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const legacy = buildUploadForm(file, 'invoice_receipt', false);
    expect(legacy.has('doc_type')).toBe(false);
    const unified = buildUploadForm(file, 'contract_legal', true);
    expect(unified.get('doc_type')).toBe('contract_legal');
  });

  it('quarantine view model keeps snippets as plain text fields', () => {
    const { buildQuarantineItemView } = loadQuarantine();
    const view = buildQuarantineItemView({
      filename: '<img onerror=alert(1)>',
      rule_ids: ['xss'],
      snippets: ['<script>alert(1)</script>', 'ok'],
    });
    expect(view.filename).toBe('<img onerror=alert(1)>');
    expect(view.snippets[0]).toBe('<script>alert(1)</script>');
    expect(view.ruleIds).toContain('xss');
  });

  it('formatActivationRefusal surfaces activation_refused reasons', () => {
    const { formatActivationRefusal } = loadEmbeddingProfiles();
    expect(formatActivationRefusal({ reason: 'activation_refused: incomplete' })).toBe(
      'activation_refused: incomplete',
    );
    expect(formatActivationRefusal({ error: 'Activation refused', reason: 'activation_refused: unknown_profile' })).toBe(
      'activation_refused: unknown_profile',
    );
  });

  it('embedding profile row view summarizes completeness', () => {
    const { buildProfileRowView } = loadEmbeddingProfiles();
    const row = buildProfileRowView({
      id: 'openai.text-3-small',
      status: 'backfilling',
      dims: 1536,
      has_evidence: true,
      completeness: { state: 'measured', percent: 42 },
    });
    expect(row.id).toBe('openai.text-3-small');
    expect(row.summary).toContain('1536');
    expect(row.evidence).toMatch(/yes/i);
  });
});

describe('config-server /api/rag proxy', () => {
  let root: string;
  let stub: http.Server;
  let stubPort: number;
  let configServer: http.Server;
  let configPort: number;
  let lastStub: StubCapture | null;

  function configCall(method: string, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const uiHeaders =
      method === 'GET' || method === 'HEAD'
        ? {}
        : { 'x-config-ui': '1', Origin: `http://127.0.0.1:${configPort}` };
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: configPort,
          method,
          path: urlPath,
          headers: {
            Host: `127.0.0.1:${configPort}`,
            ...uiHeaders,
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      lastStub = { method: req.method, url: req.url, headers: req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, stub: true }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-proxy-'));
    fs.writeFileSync(
      path.join(root, '.env.local'),
      ['NEXT_PUBLIC_APP_NAME=Demo', `MYRAG_APP_URL=http://127.0.0.1:${stubPort}`, ''].join('\n'),
    );
    process.env.MYRAG_CONFIG_ROOT = root;
    process.env.MYRAG_APP_URL = `http://127.0.0.1:${stubPort}`;
    const modPath = require.resolve('../../scripts/config-server.js');
    delete require.cache[modPath];
    const mod = require('../../scripts/config-server.js') as { server: http.Server };
    configServer = mod.server;
    await new Promise<void>((resolve) => configServer.listen(0, '127.0.0.1', resolve));
    configPort = (configServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => configServer.close(resolve));
    await new Promise((resolve) => stub.close(resolve));
    delete process.env.MYRAG_CONFIG_ROOT;
    delete process.env.MYRAG_APP_URL;
  });

  it('forwards Cookie and Authorization to the stub unchanged', async () => {
  const cookie = 'admin_session=signed-value';
    lastStub = null;
    const a = await configCall('GET', '/api/rag/admin/quarantine', { Cookie: cookie });
    expect(a.status).toBe(200);
    expect(lastStub).not.toBeNull();
    expect(lastStub!.headers.cookie).toBe(cookie);
    expect(JSON.parse(a.body).stub).toBe(true);

    lastStub = null;
    const bearer = 'Bearer ey.test.token';
    const b = await configCall('GET', '/api/rag/admin/embedding-profiles', { Authorization: bearer });
    expect(b.status).toBe(200);
    expect(lastStub).not.toBeNull();
    expect(lastStub!.headers.authorization).toBe(bearer);
  });

  it('does not invent credentials when the browser sends none', async () => {
    lastStub = null;
    const reply = await configCall('GET', '/api/rag/admin/quarantine');
    expect(reply.status).toBe(200);
    expect(lastStub).not.toBeNull();
    expect(lastStub!.headers.cookie).toBeUndefined();
    expect(lastStub!.headers.authorization).toBeUndefined();
  });

  it('refuses encoded dot segments with 400', async () => {
    lastStub = null;
    const reply = await configCall('GET', '/api/rag/%2e%2e/config');
    expect(reply.status).toBe(400);
    expect(lastStub).toBeNull();
  });

  it('refuses double-encoded dot segments that URL resolution would escape /api/rag', async () => {
    lastStub = null;
    const reply = await configCall('GET', '/api/rag/%252e%252e/admin/quarantine');
    expect(reply.status).toBe(400);
    expect(lastStub).toBeNull();
  });
});

describe('config-server static guards', () => {
  it('registers the RAG proxy and keeps withAuthHeaders usage', () => {
    const source = fs.readFileSync('scripts/config-server.js', 'utf8');
    expect(source).toContain("app.all('/api/rag/*path'");
    expect(source.match(/withAuthHeaders/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(source).not.toMatch(/console\.log\([^)]*Cookie/i);
  });

  it('index.html mounts rag panel scripts', () => {
    const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
    expect(html).toContain('rag-panels/rag-fetch.js');
    expect(html).toContain('rag-panels/doc-types.js');
    expect(html).toContain('rag-panels/quarantine.js');
    expect(html).toContain('rag-panels/embedding-profiles.js');
    expect(html).toContain('rag-administration');
  });

  it('rag panel scripts avoid browser token storage patterns', () => {
    const dir = path.join('scripts/config-ui/rag-panels');
    const merged = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(merged).not.toMatch(/sessionStorage|localStorage|anonKey|auth\/v1\/token/);
  });

  it('quarantine panel does not use innerHTML', () => {
    const source = fs.readFileSync('scripts/config-ui/rag-panels/quarantine.js', 'utf8');
    expect(source).not.toContain('innerHTML');
  });
});