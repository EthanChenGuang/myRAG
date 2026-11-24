import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../eval/harness/corpus.mts';
import { EMBEDDER_ID, EMBEDDER_VERSION, embedText, embedderSourceSha256 } from '../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID, createFixtureDatabase } from '../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TRACER_QUESTION = 'What is the refund window for annual plans?';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeTempCorpus(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-corpus-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

describe('corpus loader', () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads files in sorted relative-path order, splits on chunk markers and builds stored content', () => {
    const dir = makeTempCorpus({
      'zh/z-doc.md': '## 标题\n内容甲\n',
      'en/b-doc.md':
        '<!-- fixture-meta {"filename":"Custom.pdf","image_url":"https://example.test/x.png","created_at":"2024-02-03T00:00:00.000Z"} -->\n## Head A\nText A\n<!-- chunk -->\n\n  \n<!-- chunk -->\n## Head B\nText B\n',
      'en/a-doc.md': 'Plain body without a heading\n',
      'it/m-doc.md': '## Sezione\nTesto\n',
      'en/ignored.txt': 'not markdown',
      'fr/other.md': 'unsupported language directory',
    });
    tempDirs.push(dir);

    const { documents } = loadCorpus(dir);
    assert.deepEqual(
      documents.map((d) => d.relpath),
      ['en/a-doc.md', 'en/b-doc.md', 'it/m-doc.md', 'zh/z-doc.md'],
    );

    const [plain, custom] = documents;
    assert.equal(plain.filename, 'a-doc.md');
    assert.equal(plain.imageUrl, null);
    assert.equal(plain.createdAt, '2025-01-15T00:00:00.000Z');
    assert.equal(plain.language, 'en');
    assert.equal(plain.chunks[0].section, '');

    assert.equal(custom.filename, 'Custom.pdf');
    assert.equal(custom.imageUrl, 'https://example.test/x.png');
    assert.equal(custom.createdAt, '2024-02-03T00:00:00.000Z');
    assert.equal(custom.chunks.length, 2);
    assert.equal(custom.chunks[0].index, 0);
    assert.equal(custom.chunks[0].section, 'Head A');
    assert.equal(custom.chunks[0].text, '## Head A\nText A');
    assert.equal(custom.chunks[0].stored, 'Document: Custom.pdf. Chunk 1 of 2. Content: ## Head A\nText A');
    assert.equal(custom.chunks[1].stored, 'Document: Custom.pdf. Chunk 2 of 2. Content: ## Head B\nText B');
    assert.equal(custom.content, '## Head A\nText A\n\n## Head B\nText B');
  });

  test('document and chunk ids are UUID-shaped and identical across two loads', () => {
    const dir = makeTempCorpus({ 'en/a.md': 'one\n<!-- chunk -->\ntwo\n', 'it/b.md': 'tre\n' });
    tempDirs.push(dir);

    const first = loadCorpus(dir);
    const second = loadCorpus(dir);
    const ids = (c: typeof first) => c.documents.flatMap((d) => [d.id, ...d.chunks.map((k) => k.id)]);
    assert.deepEqual(ids(first), ids(second));
    assert.equal(first.corpusSha256, second.corpusSha256);
    for (const id of ids(first)) assert.match(id, UUID_RE);
    assert.equal(new Set(ids(first)).size, ids(first).length);
  });

  test('corpus hash changes when a byte changes', () => {
    const dir = makeTempCorpus({ 'en/a.md': 'one\n' });
    tempDirs.push(dir);
    const before = loadCorpus(dir).corpusSha256;
    fs.writeFileSync(path.join(dir, 'en/a.md'), 'one!\n');
    assert.notEqual(loadCorpus(dir).corpusSha256, before);
  });
});

describe('fixture embedder', () => {
  test('is deterministic, L2-normalized and 1536-dimensional', () => {
    assert.equal(EMBEDDER_ID, 'fixture-ngram');
    assert.equal(EMBEDDER_VERSION, 1);
    const a = embedText('Refund window for annual plans');
    const b = embedText('Refund window for annual plans');
    assert.deepEqual(a, b);
    assert.equal(a.length, 1536);
    const norm = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `norm was ${norm}`);
  });

  test('a text with no features embeds the __empty__ feature', () => {
    const empty = embedText('');
    assert.deepEqual(embedText('the of !!!'), empty);
    const nonZero = empty.filter((x) => x !== 0);
    assert.equal(nonZero.length, 1);
    assert.ok(Math.abs(Math.abs(nonZero[0]) - 1) < 1e-9);
  });

  test('related text is closer than unrelated text and Han text uses bigrams', () => {
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    const query = embedText('annual plan refund window');
    assert.ok(cos(query, embedText('The annual plan refund window is 45 days')) > cos(query, embedText('Shipping rates for oversized parcels')) + 0.2);
    const zh = embedText('退款期限是多少天');
    assert.ok(cos(zh, embedText('年度套餐的退款期限为四十五天')) > cos(zh, embedText('设备保修范围包括电池')));
  });

  test('embedderSourceSha256 is a stable sha-256 hex digest', () => {
    assert.match(embedderSourceSha256(), /^[0-9a-f]{64}$/);
    assert.equal(embedderSourceSha256(), embedderSourceSha256());
  });
});

describe('fixture database loaded with the repo SQL', () => {
  type Fixture = Awaited<ReturnType<typeof createFixtureDatabase>>;
  let singleP: Promise<Fixture> | undefined;
  let multiP: Promise<Fixture> | undefined;
  const getSingle = () => (singleP ??= createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS }));
  const getMulti = () => (multiP ??= createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: REAL_CORPUS }));
  const expectedChunks = () => loadCorpus(REAL_CORPUS).documents.flatMap((d) => d.chunks);

  after(async () => {
    await (await singleP?.catch(() => undefined))?.db.close();
    await (await multiP?.catch(() => undefined))?.db.close();
  });

  test('single-tenant: loads supabase/single-tenant-setup.sql and inserts every corpus chunk', async () => {
    const single = await getSingle();
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase/single-tenant-setup.sql'));
    assert.deepEqual(Object.keys(single.sqlSha256), ['supabase/single-tenant-setup.sql']);
    assert.equal(single.corpusSha256, loadCorpus(REAL_CORPUS).corpusSha256);
    assert.match(single.sqlSha256['supabase/single-tenant-setup.sql'], /^[0-9a-f]{64}$/);
    assert.ok(sql.length > 0);

    const rows = await single.db.query<{ id: string }>('SELECT id FROM document_chunks ORDER BY id');
    assert.deepEqual(
      rows.rows.map((r) => r.id).sort(),
      expectedChunks().map((c) => c.id).sort(),
    );
    const index = await single.db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_document_chunks_embedding'",
    );
    assert.match(index.rows[0].indexdef, /hnsw/);
  });

  test('multi-tenant: loads multi-tenant-setup.sql and sets documents.user_id to FIXTURE_USER_ID', async () => {
    const multi = await getMulti();
    assert.deepEqual(Object.keys(multi.sqlSha256), ['supabase/multi-tenant-setup.sql']);
    assert.equal(multi.fixtureUserId, FIXTURE_USER_ID);
    const owners = await multi.db.query<{ user_id: string }>('SELECT DISTINCT user_id FROM documents');
    assert.deepEqual(owners.rows.map((r) => r.user_id), [FIXTURE_USER_ID]);
    const chunks = await multi.db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks');
    assert.equal(chunks.rows[0].n, expectedChunks().length);
  });

  test('match_document_chunks returns a refund-policy.en.md chunk for the tracer question', async () => {
    const single = await getSingle();
    const result = await single.db.query<{ chunk_id: string; content: string; similarity: number }>(
      'SELECT * FROM match_document_chunks(query_embedding => $1, similarity_threshold => $2, match_count => $3)',
      [vectorLiteral(embedText(TRACER_QUESTION)), 0.1, 10],
    );
    assert.ok(result.rows.length > 0, 'no rows returned');
    assert.ok(result.rows.some((r) => r.content.startsWith('Document: refund-policy.en.md.')));
    assert.match(result.rows[0].content, /Annual plans/);
  });

  test('two database builds produce identical chunk ids and candidate order', async () => {
    const single = await getSingle();
    const again = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    try {
      const run = (db: typeof again.db) =>
        db.query<{ chunk_id: string }>(
          'SELECT chunk_id FROM match_document_chunks(query_embedding => $1, similarity_threshold => $2, match_count => $3)',
          [vectorLiteral(embedText(TRACER_QUESTION)), 0.0, 10],
        );
      assert.deepEqual((await run(again.db)).rows, (await run(single.db)).rows);
    } finally {
      await again.db.close();
    }
  });
});

describe('fake edge (PostgREST shim plus /v1/embeddings)', () => {
  type Fixture = Awaited<ReturnType<typeof createFixtureDatabase>>;
  let fixture: Fixture | undefined;
  let edge: FakeEdge | undefined;
  const getEdge = async (): Promise<FakeEdge> => {
    fixture ??= await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    edge ??= await startFakeEdge({ db: fixture.db });
    return edge;
  };
  const post = async (e: FakeEdge, route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${e.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const rpcArgs = (question: string) => ({ query_embedding: embedText(question), match_count: 25, similarity_threshold: 0.1 });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  test('listens on 127.0.0.1 only', async () => {
    const e = await getEdge();
    assert.equal(new URL(e.url).hostname, '127.0.0.1');
  });

  test('POST /v1/embeddings returns base64 Float32 vectors for encoding_format base64 and records the model', async () => {
    const e = await getEdge();
    const res = await post(e, '/v1/embeddings', { model: 'text-embedding-3-small', input: 'annual plan refund', encoding_format: 'base64' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ embedding: string; index: number }> };
    const decoded = new Float32Array(Buffer.from(body.data[0].embedding, 'base64').buffer.slice(0));
    assert.equal(decoded.length, 1536);
    const expected = embedText('annual plan refund');
    for (let i = 0; i < 1536; i += 1) assert.ok(Math.abs(decoded[i] - expected[i]) < 1e-6);
    assert.ok(e.calls.some((c) => c.path === '/v1/embeddings' && c.model === 'text-embedding-3-small'));
  });

  test('POST /v1/embeddings returns float arrays otherwise and embeds every input', async () => {
    const e = await getEdge();
    const res = await post(e, '/v1/embeddings', { model: 'm', input: ['alpha beta', 'gamma delta'] });
    const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data[1].embedding, embedText('gamma delta'));
    assert.equal(body.data[1].index, 1);
  });

  test('rpc match_document_chunks accepts named arguments with an array or pgvector text', async () => {
    const e = await getEdge();
    const asArray = await post(e, '/rest/v1/rpc/match_document_chunks', rpcArgs(TRACER_QUESTION));
    assert.equal(asArray.status, 200);
    const rows = (await asArray.json()) as Array<{ chunk_id: string; content: string }>;
    assert.ok(rows[0].content.startsWith('Document: refund-policy.en.md.'));
    const asText = await post(e, '/rest/v1/rpc/match_document_chunks', {
      ...rpcArgs(TRACER_QUESTION),
      query_embedding: vectorLiteral(embedText(TRACER_QUESTION)),
    });
    assert.deepEqual(await asText.json(), rows);
  });

  test('GET documents and document_chunks honour whitelisted select and eq filters', async () => {
    const e = await getEdge();
    const doc = loadCorpus(REAL_CORPUS).documents.find((d) => d.filename === 'refund-policy.en.md')!;
    const res = await fetch(`${e.url}/rest/v1/documents?select=id,filename&id=eq.${doc.id}`);
    assert.deepEqual(await res.json(), [{ id: doc.id, filename: 'refund-policy.en.md' }]);
    const chunks = await fetch(`${e.url}/rest/v1/document_chunks?select=content&document_id=eq.${doc.id}&limit=2`);
    assert.equal(((await chunks.json()) as unknown[]).length, 2);
  });

  test('object accept header returns 406 PGRST116 unless exactly one row matches', async () => {
    const e = await getEdge();
    const doc = loadCorpus(REAL_CORPUS).documents.find((d) => d.filename === 'refund-policy.en.md')!;
    const accept = { accept: 'application/vnd.pgrst.object+json' };
    const one = await fetch(`${e.url}/rest/v1/documents?select=id,filename&id=eq.${doc.id}`, { headers: accept });
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { id: doc.id, filename: 'refund-policy.en.md' });

    const none = await fetch(`${e.url}/rest/v1/documents?select=id&id=eq.00000000-0000-4000-8000-000000000000`, { headers: accept });
    assert.equal(none.status, 406);
    assert.equal(((await none.json()) as { code: string }).code, 'PGRST116');

    const many = await fetch(`${e.url}/rest/v1/document_chunks?select=id&document_id=eq.${doc.id}`, { headers: accept });
    assert.equal(many.status, 406);
    assert.equal(((await many.json()) as { code: string }).code, 'PGRST116');
  });

  test('unsupported paths, functions, tables, columns and operators are rejected and recorded in errors', async () => {
    const e = await startFakeEdge({ db: (await createdFixture()).db });
    try {
      const doc = loadCorpus(REAL_CORPUS).documents.find((d) => d.filename === 'refund-policy.en.md')!;
      const statuses = await Promise.all([
        fetch(`${e.url}/nope`).then((r) => r.status),
        post(e, '/rest/v1/rpc/delete_everything', {}).then((r) => r.status),
        post(e, '/rest/v1/rpc/match_document_chunks', { ...rpcArgs('x'), extra_arg: 1 }).then((r) => r.status),
        fetch(`${e.url}/rest/v1/chats?select=id`).then((r) => r.status),
        fetch(`${e.url}/rest/v1/document_chunks?select=embedding`).then((r) => r.status),
        fetch(`${e.url}/rest/v1/documents?select=id&filename=ilike.*refund*`).then((r) => r.status),
        fetch(`${e.url}/rest/v1/documents?select=id&id=neq.${doc.id}`).then((r) => r.status),
        post(e, '/rest/v1/documents', { id: 'x' }).then((r) => r.status),
      ]);
      for (const status of statuses) assert.ok(status === 400 || status === 404 || status === 405, `unexpected status ${status}`);
      assert.equal(e.errors.length, statuses.length);
      assert.ok(e.errors.every((entry) => entry.message.length > 0 && entry.status >= 400));
    } finally {
      await e.close();
    }
  });

  test('ten concurrent rpc calls return the same rows as one sequential call', async () => {
    const e = await getEdge();
    const call = async () => (await post(e, '/rest/v1/rpc/match_document_chunks', rpcArgs(TRACER_QUESTION))).json();
    const sequential = await call();
    const concurrent = await Promise.all(Array.from({ length: 10 }, call));
    for (const rows of concurrent) assert.deepEqual(rows, sequential);
  });

  test('fixtureProcessEnv overwrites vendor keys with placeholders and ignores the caller environment', () => {
    const keys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) process.env[k] = 'LIVE_SECRET_SENTINEL';
    try {
      const env = fixtureProcessEnv('http://127.0.0.1:4567');
      assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, 'http://127.0.0.1:4567');
      assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:4567/v1');
      for (const k of keys) {
        assert.ok(env[k] && env[k].length > 0, `${k} missing`);
        assert.ok(!env[k].includes('LIVE_SECRET_SENTINEL'));
      }
      assert.match(env.OPENROUTER_API_KEY, /^sk-or-[A-Za-z]{32}$/);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test('runRetrieval returns a refund-policy.en.md chunk through the edge with zero errors', async () => {
    const e = await getEdge();
    Object.assign(process.env, fixtureProcessEnv(e.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    const rag = await import('@/lib/rag');
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const result = await rag.runRetrieval({
      scope: mintScope('single', null, null),
      query: TRACER_QUESTION,
      profile: 'eval',
      options: { maxResults: 25, fallbackToLowerThreshold: true },
      signal: new AbortController().signal,
    });
    assert.ok(result.candidates.length > 0, `no chunks; edge errors: ${JSON.stringify(e.errors)}`);
    assert.ok(result.candidates.some((chunk) => chunk.content.startsWith('Document: refund-policy.en.md.')));
    assert.deepEqual(e.errors, []);
    assert.ok(e.calls.some((c) => c.path === '/v1/embeddings'));
    assert.ok(e.calls.some((c) => c.path === '/rest/v1/rpc/match_document_chunks'));
  });

  async function createdFixture(): Promise<Fixture> {
    fixture ??= await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    return fixture;
  }
});

describe('fake edge operators on the two-tenant fixture', () => {
  let tenant: TwoTenantDatabase | undefined;
  let edge: FakeEdge | undefined;
  const ids = TWO_TENANT_IDS;
  const sorted = (values: string[]) => [...values].sort();

  const getEdge = async (): Promise<FakeEdge> => {
    tenant ??= await createTwoTenantDatabase();
    edge ??= await startFakeEdge({ db: tenant.db });
    return edge;
  };
  const get = async (table: string, query: Record<string, string>) => {
    const e = await getEdge();
    return fetch(`${e.url}/rest/v1/${table}?${new URLSearchParams(query).toString()}`);
  };
  const getIds = async (table: string, query: Record<string, string>): Promise<string[]> => {
    const res = await get(table, { select: 'id', ...query });
    assert.equal(res.status, 200, `status ${res.status} for ${table} ${JSON.stringify(query)}`);
    return ((await res.json()) as Array<{ id: string }>).map((row) => row.id);
  };

  after(async () => {
    await edge?.close();
    await tenant?.db.close();
  });

  test('documents id=in.(...) returns exactly the listed rows', async () => {
    assert.deepEqual(await getIds('documents', { id: `in.(${ids.docO},${ids.docA})` }), sorted([ids.docA, ids.docO]));
    assert.deepEqual(await getIds('documents', { id: 'in.()' }), []);
  });

  test('document_chunks document_id=in.(...) and id=in.(...) return exactly the listed rows', async () => {
    assert.deepEqual(await getIds('document_chunks', { document_id: `in.(${ids.docB},${ids.docO})` }), sorted([ids.chunkB, ids.chunkO]));
    assert.deepEqual(await getIds('document_chunks', { id: `in.(${ids.chunkA})` }), [ids.chunkA]);
  });

  test('or with ilike on content, metadata->>name and metadata->>image_context plus not.is.null on metadata->>image_url', async () => {
    const logoOr = '(metadata->>name.ilike.%LOGO%,metadata->>image_context.ilike.%logo%,content.ilike.%logo%)';
    assert.deepEqual(await getIds('document_chunks', { or: logoOr, 'metadata->>image_url': 'not.is.null' }), [ids.chunkO]);
    assert.deepEqual(await getIds('document_chunks', { or: '(content.ilike.%bravo%)' }), [ids.chunkB]);
    assert.deepEqual(await getIds('document_chunks', { or: '(metadata->>name.ilike.%nothing-matches%)' }), []);
    const notNull = await getIds('document_chunks', { 'metadata->>image_url': 'not.is.null' });
    assert.ok(notNull.includes(ids.chunkO));
    assert.ok(!notNull.includes(ids.chunkA));
  });

  test('documents tenant filters: organization_id eq/is.null and user_id eq', async () => {
    assert.deepEqual(await getIds('documents', { organization_id: 'is.null', user_id: `eq.${ids.userA}` }), [ids.docA]);
    assert.deepEqual(await getIds('documents', { organization_id: 'is.null', user_id: `eq.${ids.userB}` }), [ids.docB]);
    assert.deepEqual(await getIds('documents', { organization_id: `eq.${ids.orgO}` }), [ids.docO]);
  });

  test('organization_members and organizations GET with eq filters', async () => {
    const member = await get('organization_members', { select: 'id,role', organization_id: `eq.${ids.orgO}`, user_id: `eq.${ids.userA}` });
    assert.equal(member.status, 200);
    const memberRows = (await member.json()) as Array<{ role: string }>;
    assert.equal(memberRows.length, 1);
    assert.equal(memberRows[0].role, 'member');

    const stranger = await get('organization_members', { select: 'id', organization_id: `eq.${ids.orgO}`, user_id: `eq.${ids.userB}` });
    assert.equal(stranger.status, 200);
    assert.deepEqual(await stranger.json(), []);

    const org = await get('organizations', { select: 'id,name', id: `eq.${ids.orgO}` });
    assert.equal(org.status, 200);
    assert.equal(((await org.json()) as unknown[]).length, 1);
  });

  test('every supported read is recorded as a GET in edge.calls', async () => {
    const e = await getEdge();
    e.calls.length = 0;
    await getIds('documents', { id: `in.(${ids.docA})` });
    await getIds('document_chunks', { document_id: `in.(${ids.docA})` });
    assert.deepEqual(
      e.calls.map((c) => `${c.method} ${c.path}`),
      ['GET /rest/v1/documents', 'GET /rest/v1/document_chunks'],
    );
  });

  test('any other operator still returns 400 and is counted as an edge error', async () => {
    const e = await getEdge();
    const before = e.errors.length;
    const attempts: Array<[string, Record<string, string>]> = [
      ['document_chunks', { select: 'id', content: 'fts.x' }],
      ['document_chunks', { select: 'id', or: '(content.eq.x)' }],
      ['document_chunks', { select: 'id', or: '(metadata->>other.ilike.%x%)' }],
      ['document_chunks', { select: 'id', 'metadata->>image_url': 'is.null' }],
      ['documents', { select: 'id', or: '(content.ilike.%x%)' }],
      ['documents', { select: 'id', id: 'in.(not-a-uuid)' }],
      ['documents', { select: 'id', user_id: `in.(${ids.userA})` }],
      ['documents', { select: 'id', organization_id: `neq.${ids.orgO}` }],
      ['organization_members', { select: 'id', role: 'eq.member' }],
      ['organizations', { select: 'id,documents(id)' }],
    ];
    for (const [table, query] of attempts) {
      const res = await get(table, query);
      assert.equal(res.status, 400, `${table} ${JSON.stringify(query)} returned ${res.status}`);
    }
    assert.equal(e.errors.length - before, attempts.length);
  });
});

describe('fake edge generic rag_* rpc routing', () => {
  type Fixture = Awaited<ReturnType<typeof createFixtureDatabase>>;
  let fixture: Fixture | undefined;
  let edge: FakeEdge | undefined;
  const getFixture = async (): Promise<Fixture> => {
    fixture ??= await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    return fixture;
  };
  const getEdge = async (): Promise<FakeEdge> => {
    edge ??= await startFakeEdge({ db: (await getFixture()).db });
    return edge;
  };
  const rpc = async (name: string, body: unknown) => {
    const e = await getEdge();
    return fetch(`${e.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  const beginArgs = (sourceKey: string) => ({
    p_tenant_key: 's:default',
    p_user_id: null,
    p_org_id: null,
    p_source: 'config_upload',
    p_source_key: sourceKey,
    p_filename: 'edge-fixture.md',
    p_file_sha256: null,
    p_doc_type: 'general',
    p_doc_type_origin: 'fallback',
    p_profile_id: 'general-1',
    p_profile_version: 1,
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  test('a rag_* function in the database is called with named arguments and answers with an array of rows', async () => {
    const e = await getEdge();
    const begun = await rpc('rag_begin_document_version', beginArgs('edge/routing.md'));
    assert.equal(begun.status, 200);
    const rows = (await begun.json()) as Array<{ outcome: string; document_id: string; version: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, 'created');
    const read = await rpc('rag_get_ingest_document', { p_document_id: rows[0]?.document_id, p_tenant_key: 's:default' });
    assert.equal(read.status, 200);
    const doc = (await read.json()) as Array<{ status: string; version: number; filename: string }>;
    assert.deepEqual(doc.map((row) => [row.status, row.version, row.filename]), [['processing', 1, 'edge-fixture.md']]);
    assert.ok(e.calls.some((call) => call.path === '/rest/v1/rpc/rag_get_ingest_document'));
    const none = await rpc('rag_get_ingest_document', { p_document_id: rows[0]?.document_id, p_tenant_key: 'u:00000000-0000-4000-8000-000000000999' });
    assert.deepEqual(await none.json(), []);
  });

  test('an argument the function does not have returns 400 and is recorded', async () => {
    const e = await getEdge();
    const before = e.errors.length;
    const res = await rpc('rag_get_ingest_document', { p_document_id: FIXTURE_USER_ID, p_tenant_key: 's:default', p_extra: 1 });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /p_extra/);
    assert.equal(e.errors.length - before, 1);
  });

  test('names outside the legacy specs, rag_* and match_chunks_by_profile return 404, and so does a rag_* name with no function', async () => {
    const e = await getEdge();
    const before = e.errors.length;
    const names = ['match_document_chunks_by_org', 'get_documents_by_type_slug', 'delete_everything', 'RAG_get_ingest_document', 'rag_no_such_function', 'match_chunks_by_profile'];
    for (const name of names) {
      const res = await rpc(name, {});
      assert.equal(res.status, 404, name);
    }
    assert.equal(e.errors.length - before, names.length);
  });

  test('vector and halfvec arguments sent as arrays are converted, jsonb arguments pass through and other values bind as they are', async () => {
    const { db } = await getFixture();
    await db.exec(`CREATE FUNCTION rag_test_echo(p_full vector, p_half halfvec, p_payload jsonb, p_count integer, p_note text)
      RETURNS TABLE (full_dims integer, half_dims integer, payload jsonb, doubled integer, note text) LANGUAGE sql
      AS $$ SELECT vector_dims(p_full), vector_dims(p_half), p_payload, p_count * 2, p_note $$`);
    const payload = { chunks: [{ chunk_index: 0, content: 'x' }], nested: { ok: true } };
    const res = await rpc('rag_test_echo', { p_full: [0.5, 0.25, 0.125], p_half: [1, 2, 3, 4], p_payload: payload, p_count: 21, p_note: null });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ full_dims: 3, half_dims: 4, payload, doubled: 42, note: null }]);
    const text = await rpc('rag_test_echo', { p_full: '[1,2]', p_half: '[1,2,3]', p_payload: [1, 2], p_count: 1, p_note: 'n' });
    assert.deepEqual(await text.json(), [{ full_dims: 2, half_dims: 3, payload: [1, 2], doubled: 2, note: 'n' }]);
    const bad = await rpc('rag_test_echo', { p_full: [1, 'x'], p_half: [1], p_payload: {}, p_count: 1, p_note: 'n' });
    assert.equal(bad.status, 400);
  });

  test('a function that raises answers 400 with the PostgREST body, the SQLSTATE as code and the message text', async () => {
    const { db } = await getFixture();
    await db.exec(`CREATE FUNCTION rag_test_raise(p_dims integer) RETURNS TABLE (ok boolean) LANGUAGE plpgsql AS $$
      BEGIN
        IF p_dims = 1 THEN RAISE EXCEPTION 'embedding_profile_mismatch: expected %', p_dims USING DETAIL = 'profile detail', HINT = 'use the active profile'; END IF;
        IF p_dims = 2 THEN RAISE EXCEPTION 'blocked' USING ERRCODE = '42501'; END IF;
        RETURN QUERY SELECT true;
      END $$`);
    const e = await getEdge();
    const before = e.errors.length;
    const mismatch = await rpc('rag_test_raise', { p_dims: 1 });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), {
      code: 'P0001',
      message: 'embedding_profile_mismatch: expected 1',
      details: 'profile detail',
      hint: 'use the active profile',
    });
    const forbidden = await rpc('rag_test_raise', { p_dims: 2 });
    assert.equal(forbidden.status, 403);
    assert.equal(((await forbidden.json()) as { code: string }).code, '42501');
    assert.equal(e.errors.length - before, 2);
    assert.deepEqual(await (await rpc('rag_test_raise', { p_dims: 3 })).json(), [{ ok: true }]);
  });

  test('a call that does not match the function signature is refused with the database error, not a crash', async () => {
    const res = await rpc('rag_get_ingest_document', { p_document_id: 'not-a-uuid', p_tenant_key: 's:default' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, '22P02');
    assert.match(body.message, /uuid/);
  });

  test('the two legacy rpc specs keep their argument lists and their error shape', async () => {
    const e = await getEdge();
    const question = embedText('What is the refund window for annual plans?');
    const ok = await rpc('match_document_chunks', { query_embedding: question, match_count: 5, similarity_threshold: 0.1 });
    assert.equal(ok.status, 200);
    const extra = await rpc('match_document_chunks', { query_embedding: question, match_count: 5, similarity_threshold: 0.1, p_extra: 1 });
    assert.equal(extra.status, 400);
    assert.equal(((await extra.json()) as { code: string }).code, 'FAKE_EDGE_UNSUPPORTED');
    assert.ok(e.calls.some((call) => call.path === '/rest/v1/rpc/match_document_chunks'));
  });
});
