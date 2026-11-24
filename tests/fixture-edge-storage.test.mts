import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createFixtureDatabase } from '../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../eval/harness/fake-edge.mts';
import { startIngestAppServer, type IngestRouteHandler } from '../eval/harness/ingest-app-server.mts';
import { spawnSidecarModule } from '../eval/harness/sidecar-worker.mts';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const JWT_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fixture-signature-placeholder';
const SB_SECRET_KEY = 'sb_secret_fixture_edge_test_key_00000000';
const ANON_KEY = 'fixture-anon-key-placeholder';

function storageHeaders(
  key: string,
  extra?: HeadersInit & { authorization?: string },
): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (extra?.authorization) headers.authorization = extra.authorization;
  return headers;
}

function storageObjectUrl(edge: FakeEdge, bucket: string, objectKey: string): string {
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  return `${edge.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedKey}`;
}

async function storagePut(
  edge: FakeEdge,
  bucket: string,
  objectKey: string,
  body: Uint8Array,
  key: string,
  method: 'POST' | 'PUT' = 'POST',
): Promise<Response> {
  return fetch(storageObjectUrl(edge, bucket, objectKey), {
    method,
    headers: { ...storageHeaders(key), 'content-type': 'application/octet-stream' },
    body,
  });
}

describe('fake edge storage', () => {
  let edge: FakeEdge;
  let closeDb: () => Promise<void>;

  after(async () => {
    await edge?.close();
    await closeDb?.();
  });

  test('setup', async () => {
    const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    closeDb = () => fixture.db.close();
    edge = await startFakeEdge({
      db: fixture.db,
      serviceKeys: [JWT_SERVICE_KEY, SB_SECRET_KEY],
      anonKey: ANON_KEY,
    });
  });

  test('upload then download returns the same 3 MiB bytes', async () => {
    const tenant = `u:${randomUUID()}`;
    const sha = 'a'.repeat(64);
    const objectKey = `${tenant}/_parse-cache/${sha}/x/docling.json`;
    const payload = new Uint8Array(randomBytes(3 * 1024 * 1024));
    const bucket = 'rag-originals';

    const put = await storagePut(edge, bucket, objectKey, payload, JWT_SERVICE_KEY);
    assert.equal(put.status, 200, await put.text());

    const get = await fetch(storageObjectUrl(edge, bucket, objectKey), {
      headers: storageHeaders(JWT_SERVICE_KEY),
    });
    assert.equal(get.status, 200);
    const got = new Uint8Array(await get.arrayBuffer());
    assert.equal(got.length, payload.length);
    assert.equal(Buffer.compare(Buffer.from(got), Buffer.from(payload)), 0);
  });

  test('HEAD returns content length; list by prefix finds object; DELETE removes it', async () => {
    const objectKey = `u:${randomUUID()}/_parse-cache/b/x/out.json`;
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bucket = 'rag-originals';
    await storagePut(edge, bucket, objectKey, payload, SB_SECRET_KEY);

    const head = await fetch(storageObjectUrl(edge, bucket, objectKey), {
      method: 'HEAD',
      headers: storageHeaders(SB_SECRET_KEY),
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(payload.length));

    const list = await fetch(`${edge.url}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...storageHeaders(SB_SECRET_KEY), 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: objectKey.slice(0, objectKey.lastIndexOf('/')), limit: 100 }),
    });
    assert.equal(list.status, 200);
    const listed = (await list.json()) as Array<{ name: string }>;
    assert.ok(listed.some((row) => row.name === objectKey));

    const del = await fetch(storageObjectUrl(edge, bucket, objectKey), {
      method: 'DELETE',
      headers: storageHeaders(SB_SECRET_KEY),
    });
    assert.equal(del.status, 200);

    const missing = await fetch(storageObjectUrl(edge, bucket, objectKey), {
      headers: storageHeaders(SB_SECRET_KEY),
    });
    assert.equal(missing.status, 404);
  });

  test('refuses invalid object keys with 400', async () => {
    const badKeys = [`u:${randomUUID()}/foo../secret`, `u:${randomUUID()}/café.json`];
    for (const key of badKeys) {
      const res = await storagePut(edge, 'rag-originals', key, new Uint8Array([0]), JWT_SERVICE_KEY);
      assert.equal(res.status, 400, key);
    }
  });

  test('service key shapes: JWT with Bearer, JWT apikey-only, sb_secret apikey-only; sb_secret Bearer-only refused', async () => {
    const objectKey = `u:${randomUUID()}/shape-check.json`;
    const body = new Uint8Array([9]);

    const jwtBearer = await storagePut(edge, 'rag-originals', objectKey, body, JWT_SERVICE_KEY, 'PUT');
    assert.equal(jwtBearer.status, 200);

    const jwtApiOnly = await fetch(storageObjectUrl(edge, 'rag-originals', objectKey), {
      method: 'GET',
      headers: storageHeaders(JWT_SERVICE_KEY),
    });
    assert.equal(jwtApiOnly.status, 200);

    const secretOnly = await storagePut(edge, 'rag-originals', `u:${randomUUID()}/s.json`, body, SB_SECRET_KEY);
    assert.equal(secretOnly.status, 200);

    const secretBearerOnly = await fetch(storageObjectUrl(edge, 'rag-originals', 'x.json'), {
      method: 'POST',
      headers: { authorization: `Bearer ${SB_SECRET_KEY}`, 'content-type': 'application/octet-stream' },
      body,
    });
    assert.equal(secretBearerOnly.status, 401);
  });

  test('anon key gets 401 on storage routes', async () => {
    const res = await storagePut(edge, 'rag-originals', `u:${randomUUID()}/anon.json`, new Uint8Array([1]), ANON_KEY);
    assert.equal(res.status, 401);
  });

  test('records storage calls in edge.calls', async () => {
    const before = edge.calls.length;
    await storagePut(edge, 'rag-originals', `u:${randomUUID()}/logged.json`, new Uint8Array([7]), JWT_SERVICE_KEY);
    const logged = edge.calls.slice(before);
    assert.ok(logged.some((c) => c.path.includes('storage/v1')));
  });
});

describe('ingest app callback server', () => {
  test('dispatches POST advance and returns 404 for unknown actions', async () => {
    const jobId = randomUUID();
    const handler: IngestRouteHandler = async (_req, ctx) => {
      const params = await ctx.params;
      assert.equal(params.id, jobId);
      return Response.json({ ok: true, stage: 'advance' }, { status: 202 });
    };

    const server = await startIngestAppServer({ advance: handler });
    try {
      const good = await fetch(`${server.url}/api/internal/rag/ingest/jobs/${jobId}/advance`, { method: 'POST' });
      assert.equal(good.status, 202);
      const body = (await good.json()) as { ok: boolean; stage: string };
      assert.equal(body.ok, true);
      assert.equal(body.stage, 'advance');

      const missing = await fetch(`${server.url}/api/internal/rag/ingest/jobs/${jobId}/nope`, { method: 'POST' });
      assert.equal(missing.status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('sidecar module launcher', () => {
  test('json.tool smoke exits 0 and captures stdout', async () => {
    const proc = spawnSidecarModule('json.tool', ['--help'], {}, { timeoutMs: 30_000 });
    const result = await proc.done;
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /usage/i);
    assert.equal(result.env.RAG_SIDECAR_ENV, 'test');
    assert.equal('SUPABASE_SERVICE_ROLE_KEY' in result.env, false);
  });

  test('kills a slow module on timeout', async () => {
    const proc = spawnSidecarModule('timeit', ['-n', '1', 'import time; time.sleep(30)'], {}, { timeoutMs: 500 });
    const result = await proc.done;
    assert.equal(result.timedOut, true);
    proc.kill();
  });

  test('child env is explicit keys plus PATH, HOME and RAG_SIDECAR_ENV=test', async () => {
    const proc = spawnSidecarModule(
      'json.tool',
      ['--help'],
      { ONLY_PASSED: '1', RAG_SIDECAR_ENV: 'production' },
      { timeoutMs: 30_000 },
    );
    const result = await proc.done;
    assert.equal(result.env.ONLY_PASSED, '1');
    assert.equal(result.env.RAG_SIDECAR_ENV, 'test');
    assert.ok(result.env.PATH);
    assert.ok(result.env.HOME ?? result.env.HOMEPATH);
  });
});