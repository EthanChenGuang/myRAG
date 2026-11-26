import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ENDPOINT = '/api/config/query-layer/status';

let root: string;
let server: http.Server;
let port: number;

function call(method: string, url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host ?? `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECRETS = ['placeholder-langsmith-key', 'placeholder-openrouter-key', 'redis://placeholder-host:6379'];

function writeEnv(lines: string[]) {
  fs.writeFileSync(
    path.join(root, '.env.local'),
    [...lines, 'OPENROUTER_API_KEY=placeholder-openrouter-key', 'REDIS_URL=redis://placeholder-host:6379', ''].join('\n'),
  );
}

const calibrationPath = () => path.join(root, 'eval/config/semantic-cache.json');
const langchainDir = () => path.join(root, 'node_modules/@langchain/classic');

function installFakeLangchain() {
  fs.mkdirSync(langchainDir(), { recursive: true });
  fs.writeFileSync(path.join(langchainDir(), 'package.json'), JSON.stringify({ name: '@langchain/classic', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(langchainDir(), 'index.js'), 'module.exports = {};\n');
}

async function status() {
  const reply = await call('GET', ENDPOINT);
  expect(reply.status).toBe(200);
  for (const secret of SECRETS) expect(reply.body).not.toContain(secret);
  return JSON.parse(reply.body) as {
    framework: string;
    backend: string;
    pipeline: string;
    langchain_installed: boolean;
    calibration: { calibrated: boolean; state: string; profiles: Array<Record<string, unknown>> };
    warnings: string[];
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-query-layer-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  writeEnv([]);
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

beforeEach(() => {
  fs.rmSync(path.join(root, 'eval'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  writeEnv([]);
});

describe('GET /api/config/query-layer/status', () => {
  it('status: defaults report llamaindex, the cache off, calibrated false and no warnings', async () => {
    const body = await status();
    expect(body).toMatchObject({ framework: 'llamaindex', backend: 'off', pipeline: 'legacy', langchain_installed: false, warnings: [] });
    expect(body.calibration).toEqual({ calibrated: false, state: 'missing', profiles: [] });
  });

  it('status: the cache on under the legacy pipeline warns cache_under_legacy, and v2 does not', async () => {
    writeEnv(['RAG_SEMANTIC_CACHE=pgvector']);
    expect((await status()).warnings).toEqual(['cache_under_legacy']);
    writeEnv(['RAG_SEMANTIC_CACHE=redisvl', 'RAG_PIPELINE=legacy']);
    expect((await status()).warnings).toEqual(['cache_under_legacy']);
    writeEnv(['RAG_SEMANTIC_CACHE=pgvector', 'RAG_PIPELINE=v2']);
    expect((await status()).warnings).toEqual([]);
  });

  it('status: LangChain selected without its package warns langchain_missing; installed it does not', async () => {
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain']);
    const missing = await status();
    expect(missing.langchain_installed).toBe(false);
    expect(missing.warnings).toEqual(['langchain_missing']);
    installFakeLangchain();
    const installed = await status();
    expect(installed.langchain_installed).toBe(true);
    expect(installed.warnings).toEqual([]);
  });

  it('status: LANGSMITH_* or LANGCHAIN_TRACING* with LangChain selected warns langsmith_tracing_set, without the value', async () => {
    installFakeLangchain();
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'LANGSMITH_API_KEY=placeholder-langsmith-key']);
    expect((await status()).warnings).toEqual(['langsmith_tracing_set']);
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'LANGCHAIN_TRACING_V2=true']);
    expect((await status()).warnings).toEqual(['langsmith_tracing_set']);
    writeEnv(['RAG_QUERY_FRAMEWORK=llamaindex', 'LANGSMITH_API_KEY=placeholder-langsmith-key']);
    expect((await status()).warnings).toEqual([]);
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'LANGSMITH_API_KEY=']);
    expect((await status()).warnings).toEqual([]);
  });

  it('status: reads the calibrated distance per embedding profile from eval/config/semantic-cache.json on each call', async () => {
    fs.mkdirSync(path.dirname(calibrationPath()), { recursive: true });
    fs.writeFileSync(
      calibrationPath(),
      JSON.stringify({
        schema_version: 1,
        profiles: [
          { embedding_profile_id: 'legacy', max_distance: 0.06, source: 'calibrated', fitted_at: '2026-11-20T00:00:00Z', dev: null, test: null },
          { embedding_profile_id: 'profile-b', max_distance: 0.05, source: 'default', fitted_at: null, dev: null, test: null },
        ],
      }),
    );
    const body = await status();
    expect(body.calibration).toEqual({
      calibrated: true,
      state: 'ok',
      profiles: [
        { embedding_profile_id: 'legacy', max_distance: 0.06, source: 'calibrated', fitted_at: '2026-11-20T00:00:00Z' },
        { embedding_profile_id: 'profile-b', max_distance: 0.05, source: 'default', fitted_at: null },
      ],
    });
    fs.writeFileSync(calibrationPath(), '{not json');
    expect((await status()).calibration).toEqual({ calibrated: false, state: 'invalid', profiles: [] });
    fs.writeFileSync(calibrationPath(), JSON.stringify({ schema_version: 1, profiles: [{ embedding_profile_id: '<b>', max_distance: 0.9, source: 'calibrated' }] }));
    expect((await status()).calibration).toEqual({ calibrated: false, state: 'invalid', profiles: [] });
  });

  it('status: all three warnings together, in a fixed order', async () => {
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'RAG_SEMANTIC_CACHE=pgvector', 'LANGCHAIN_TRACING=true']);
    expect((await status()).warnings).toEqual(['cache_under_legacy', 'langchain_missing', 'langsmith_tracing_set']);
  });

  it('status: refuses a foreign Host like every config endpoint', async () => {
    const reply = await call('GET', ENDPOINT, 'evil.example');
    expect(reply.status).toBeGreaterThanOrEqual(400);
  });
});
