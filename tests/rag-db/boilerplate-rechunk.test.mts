import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

/**
 * Plan 03.3-10 Task 4 (D-06, D-07, D-21): rag:rechunk cleans the stored parse output with the tenant's current rules, without a parser
 * call, and stores the report after its profile write; the dry run writes nothing. Own file: one fixture database per process.
 */

type Row = Record<string, unknown>;

const RULED_LINE = 'Internal circulation marker qv';
const PATTERN = '^Internal circulation marker';

function documentText(seed: string): string {
  const sections = ['first', 'second', 'third'].map((name) =>
    [`## Section ${name} ${seed}`, '', RULED_LINE, '', `The ${name} section of the ${seed} sample holds ordinary neutral sentences that describe a plain process in several steps.`, ''].join('\n'),
  );
  return [`# Sample ${seed}`, '', ...sections].join('\n');
}

describe('re-chunk prepares from the stored parse output with the tenant’s current rules', () => {
  const PROFILE = 'p256bp';
  const A = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let rulesModule: typeof import('@/lib/rag/ingest/rules/load');
  let store: import('../helpers/fake-object-store').FakeObjectStore;
  let documentId = '';

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const scopeFor = async (tenantKey: string) => (tenantKey === A.key ? scopeModule.mintScope('personal', A.userId, null) : null);
  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_EMBEDDING_PROFILES: 'off', ...env }),
      embedDocuments: async (texts) => texts.map((text, index) => Array.from({ length: 1536 }, (_, i) => (i === (text.length + index) % 1536 ? 1 : 0))),
    });
  };
  const children = async () =>
    (await rows('SELECT content FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY chunk_index', [documentId, PROFILE])).map((row) => String(row.content));
  const parseBytes = () => {
    for (const [key, value] of store.objects) if (key.endsWith('/parse.md')) return new TextDecoder().decode(value.bytes);
    return null;
  };

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'boilerplate-rechunk-'));
    try {
      fixture = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rechunk = await import('@/lib/rag/ingest/rechunk/run');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    ingestModule = await import('@/lib/rag/ingest');
    scopeModule = await import('@/lib/rag/tenant/scope');
    rulesModule = await import('@/lib/rag/ingest/rules/load');
    store = (await import('../helpers/fake-object-store')).createFakeObjectStore();
    objectStoreModule.setObjectStoreForTests(store);
    await fixture.db.exec(`INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
      VALUES ('${PROFILE}', 'general', 256, 'structure', 1024, 'building', '256/1024') ON CONFLICT DO NOTHING`);
    useEnv({ RAG_PAGE_BOILERPLATE: 'off' });
    const result = await ingestModule.ingest({
      scope: scopeModule.mintScope('personal', A.userId, null),
      source: 'config_upload',
      sourceKey: 'root/rechunk-clean.md',
      text: documentText('rechunk'),
      filename: 'rechunk-clean.md',
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'ready');
    documentId = String(result.documentId);
  });

  after(async () => {
    objectStoreModule?.resetObjectStoreForTests();
    depsModule?.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(async () => {
    rulesModule.resetTenantRuleCacheForTests();
    await fixture.db.exec(`
      DELETE FROM chunking_build_gaps;
      DELETE FROM chunking_build_runs;
      DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM document_chunks WHERE chunking_profile_id <> 'legacy');
      DELETE FROM document_chunks WHERE chunking_profile_id <> 'legacy';
      DELETE FROM document_parents;
      DELETE FROM rag_boilerplate_rules;
      UPDATE chunking_profiles SET status = 'building' WHERE id = '${PROFILE}';`);
  });

  test('off: the re-chunk keeps the line and writes no report', async () => {
    useEnv({ RAG_PAGE_BOILERPLATE: 'off' });
    const report = await rechunk.runRechunk({ db: depsModule.getIngestDeps().db() as RpcClient, profileId: PROFILE, scopeFor });
    assert.equal(report.documentsWritten, 1);
    assert.ok((await children()).join('\n').includes(RULED_LINE));
    const [doc] = await rows("SELECT metadata ? 'boilerplate' AS has FROM documents WHERE id = $1", [documentId]);
    assert.equal(doc?.has, false);
  });

  test('a rule added after ingestion: the dry run writes nothing, the real run removes the line without a parser call and stores the report', async () => {
    const parseBefore = parseBytes();
    await fixture.db.query("INSERT INTO public.rag_boilerplate_rules (tenant_key, name, kind, pattern, flags) VALUES ($1, 'late-rule', 'line', $2, 'u')", [A.key, PATTERN]);
    useEnv({ RAG_PAGE_BOILERPLATE: 'rules' });
    const db = depsModule.getIngestDeps().db() as RpcClient;
    const dry = await rechunk.dryRunRechunk({ db, profileId: PROFILE, scopeFor });
    assert.deepEqual(dry.gaps.filter((gap) => gap.documentId === documentId), []);
    assert.equal((await children()).length, 0, 'the dry run writes no child');
    const [beforeRun] = await rows("SELECT metadata ? 'boilerplate' AS has FROM documents WHERE id = $1", [documentId]);
    assert.equal(beforeRun?.has, false, 'the dry run writes no report');

    const puts = store.calls.filter((call) => call.op === 'put').length;
    const report = await rechunk.runRechunk({ db, profileId: PROFILE, scopeFor });
    assert.equal(report.documentsWritten, 1);
    const contents = await children();
    assert.ok(contents.length > 0);
    for (const content of contents) assert.ok(!content.includes(RULED_LINE), 'no child holds the ruled line');
    assert.equal(parseBytes(), parseBefore, 'parse.md keeps its bytes');
    assert.equal(store.calls.filter((call) => call.op === 'put').length, puts, 'nothing is stored: no parser ran');
    const [doc] = await rows("SELECT (metadata -> 'boilerplate' ->> 'lines_removed')::int AS removed FROM documents WHERE id = $1", [documentId]);
    assert.equal(doc?.removed, 3);
  });

  test('a tenant scope that cannot be resolved stays the tenant_scope_refused gap', async () => {
    useEnv({ RAG_PAGE_BOILERPLATE: 'rules' });
    const report = await rechunk.runRechunk({ db: depsModule.getIngestDeps().db() as RpcClient, profileId: PROFILE, scopeFor: async () => null });
    assert.deepEqual(report.gaps.filter((gap) => gap.documentId === documentId).map((gap) => gap.detail), ['tenant_scope_refused']);
  });
});
