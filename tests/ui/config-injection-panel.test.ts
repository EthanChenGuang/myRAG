import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const ENDPOINT = '/api/config/injection-defense';

let root: string;
let server: http.Server;
let port: number;

interface Reply {
  status: number;
  body: string;
}

function call(method: string, url: string, options: { host?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}`, ...(options.headers ?? {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const rulesPath = () => path.join(root, 'config/rag/injection-rules.json');
const detectorsPath = () => path.join(root, 'config/rag/injection-detectors.json');

function copyRealConfig() {
  fs.mkdirSync(path.join(root, 'config/rag'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'config/rag/injection-rules.json'), rulesPath());
  fs.copyFileSync(path.join(repoRoot, 'config/rag/injection-detectors.json'), detectorsPath());
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-injection-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.env.local'),
    ['LAKERA_GUARD_API_KEY=placeholder-lakera-key', 'RAG_INJECTION_CHECK=drop', 'RAG_SIDECAR_SECRET=placeholder-sidecar-secret', ''].join('\n'),
  );
  copyRealConfig();
  process.env.MYRAG_CONFIG_ROOT = root;
  const mod = require('../../scripts/config-server.js') as { server: http.Server };
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
});

beforeEach(() => copyRealConfig());

describe('GET /api/config/injection-defense (D-18)', () => {
  it('returns the rule version, counts per language and the detector summary', async () => {
    const reply = await call('GET', ENDPOINT);
    expect(reply.status).toBe(200);
    const bytes = fs.readFileSync(path.join(repoRoot, 'config/rag/injection-rules.json'));
    const rules = JSON.parse(bytes.toString('utf8')) as { rules: Array<{ language: string }> };
    const detectors = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/rag/injection-detectors.json'), 'utf8'));
    const count = (lang: string) => rules.rules.filter((r) => r.language === lang).length;
    expect(JSON.parse(reply.body)).toEqual({
      rules: {
        version: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
        counts: { zh: count('zh'), en: count('en'), it: count('it'), any: count('any') },
      },
      detectors: {
        version: detectors.version,
        prompt_guard: {
          model_id: detectors.prompt_guard.model_id,
          revision: detectors.prompt_guard.revision,
          threshold: detectors.prompt_guard.threshold,
          languages: detectors.prompt_guard.languages,
        },
        lakera: { detector_types: detectors.lakera.detector_types, min_level: detectors.lakera.min_level },
      },
    });
  });

  it('the rule version equals injectionRulesVersion() for the same file', async () => {
    const { injectionRulesVersion } = await import('@/lib/rag/security/injection-rules');
    const reply = await call('GET', ENDPOINT);
    expect(JSON.parse(reply.body).rules.version).toBe(injectionRulesVersion(path.join(repoRoot, 'config/rag/injection-rules.json')));
  });

  it('returns no rule pattern, rule id or env value', async () => {
    const reply = await call('GET', ENDPOINT);
    const rules = JSON.parse(fs.readFileSync(rulesPath(), 'utf8')) as { rules: Array<{ id: string; pattern: string }> };
    for (const rule of rules.rules) {
      expect(reply.body).not.toContain(rule.pattern);
      expect(reply.body).not.toContain(rule.id);
    }
    for (const value of ['placeholder-lakera-key', 'placeholder-sidecar-secret', 'pattern', '"drop"']) expect(reply.body).not.toContain(value);
  });

  it('reads the files on each request (no caching)', async () => {
    const first = JSON.parse((await call('GET', ENDPOINT)).body);
    const detectors = JSON.parse(fs.readFileSync(detectorsPath(), 'utf8'));
    detectors.version = '2030-01-01.7';
    fs.writeFileSync(detectorsPath(), JSON.stringify(detectors));
    fs.appendFileSync(rulesPath(), '\n');
    const second = JSON.parse((await call('GET', ENDPOINT)).body);
    expect(second.detectors.version).toBe('2030-01-01.7');
    expect(second.rules.version).not.toBe(first.rules.version);
  });

  it('refuses a foreign Host exactly like GET /api/config', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:9999']) {
      const reply = await call('GET', ENDPOINT, { host });
      const reference = await call('GET', '/api/config', { host });
      expect(reply.status).toBe(403);
      expect(reply.body).toBe(reference.body);
      expect(reply.body).not.toContain('prompt_guard');
    }
  });

  it('refuses a cross-site POST exactly like the other config endpoints', async () => {
    const reply = await call('POST', ENDPOINT, { headers: { Origin: 'http://evil.example' } });
    const reference = await call('POST', '/api/config', { headers: { Origin: 'http://evil.example' } });
    expect(reply.status).toBe(403);
    expect(reply.body).toBe(reference.body);
  });

  it.each([
    ['missing detector file', () => fs.rmSync(detectorsPath()), 'injection_detectors_missing'],
    ['detector file that is not JSON', () => fs.writeFileSync(detectorsPath(), '{not json'), 'injection_detectors_invalid'],
    [
      'detector file with a bad revision',
      () => {
        const d = JSON.parse(fs.readFileSync(detectorsPath(), 'utf8'));
        d.prompt_guard.revision = '<script>';
        fs.writeFileSync(detectorsPath(), JSON.stringify(d));
      },
      'injection_detectors_invalid',
    ],
    [
      'detector file without lakera',
      () => {
        const d = JSON.parse(fs.readFileSync(detectorsPath(), 'utf8'));
        delete d.lakera;
        fs.writeFileSync(detectorsPath(), JSON.stringify(d));
      },
      'injection_detectors_invalid',
    ],
    ['missing rule file', () => fs.rmSync(rulesPath()), 'injection_rules_missing'],
    ['rule file without rules', () => fs.writeFileSync(rulesPath(), '{"schema_version":1}'), 'injection_rules_invalid'],
  ])('a %s answers 500 with a code and no stack', async (_name, mutate, code) => {
    mutate();
    const reply = await call('GET', ENDPOINT);
    expect(reply.status).toBe(500);
    const body = JSON.parse(reply.body);
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(reply.body).not.toMatch(/at .*\.js:\d+|ENOENT|Unexpected token|SyntaxError/);
    expect(reply.body).not.toContain(root);
  });
});
