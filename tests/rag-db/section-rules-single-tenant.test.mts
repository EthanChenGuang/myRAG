import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

/**
 * Plan 03.3-12 (TPL-01): the single-tenant run of section rules. A rule set of s:default cuts a conforming document as in multi-tenant
 * mode, and the switch off ignores it. Own file: one fixture database per process. Rule set and document are invented.
 */

type Row = Record<string, unknown>;

const HEADINGS = [
  { pattern: '^Part [0-9]+', flags: 'u', name: 'Part', level: 1, required: true, restart: true },
  { pattern: '^[0-9]+\\. Alpha', flags: 'u', name: 'Alpha', level: 2, required: true, restart: false },
];

const TEXT = [
  '# Collection single',
  '',
  '## Part 1',
  '',
  'Opening text of part 1.',
  '',
  '1. Alpha',
  '',
  'The single passage holds ordinary neutral sentences that describe a plain process in several steps.',
  '',
].join('\n');

describe('section rules through the pipeline (single-tenant)', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');

  before(async () => {
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'section-rules-single-'));
    try {
      fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    scopeModule = await import('@/lib/rag/tenant/scope');
    objectStoreModule.setObjectStoreForTests((await import('../helpers/fake-object-store')).createFakeObjectStore());
    await fixture.db.query(`INSERT INTO public.rag_section_rule_sets (tenant_key, name, doc_type, rules) VALUES ('s:default', 'single-set', 'general', $1::jsonb)`, [
      JSON.stringify({ headings: HEADINGS, require_increasing_numbers: false, skip_toc: true, toc_min_run: 3 }),
    ]);
  });

  after(async () => {
    objectStoreModule?.resetObjectStoreForTests();
    depsModule?.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  const useEnv = (env: Record<string, string>) => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_EMBEDDING_PROFILES: 'off', ...env }),
      embedDocuments: async (texts) => texts.map((text, index) => Array.from({ length: 1536 }, (_, i) => (i === (text.length + index) % 1536 ? 1 : 0))),
    });
  };

  const upload = async (label: string) =>
    ingestModule.ingest({
      scope: scopeModule.mintScope('single', null, null),
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text: `${TEXT}\n${label}\n`,
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });

  const paths = async (documentId: string) =>
    (await fixture.db.query<Row>("SELECT section_path FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'legacy' ORDER BY chunk_index", [documentId])).rows.map(
      (row) => row.section_path as string[],
    );

  test('switch on: the s:default rule set cuts the document; switch off: the profile chunker does', async () => {
    useEnv({ RAG_SECTION_RULES: 'on' });
    const ruled = await upload('single-on');
    assert.equal(ruled.status, 'ready');
    assert.ok((await paths(ruled.documentId!)).some((p) => JSON.stringify(p) === JSON.stringify(['Part', 'Alpha'])));
    const [doc] = (await fixture.db.query<Row>("SELECT metadata -> 'section_rules' AS section_rules, needs_review FROM documents WHERE id = $1", [ruled.documentId])).rows;
    assert.equal((doc?.section_rules as Row).satisfied, true);
    assert.equal(doc?.needs_review, false);

    useEnv({ RAG_SECTION_RULES: 'off' });
    const plain = await upload('single-off');
    assert.equal(plain.status, 'ready');
    assert.ok((await paths(plain.documentId!)).every((p) => !p.includes('Alpha') || p[0] === 'Collection single'));
    const [plainDoc] = (await fixture.db.query<Row>("SELECT metadata ? 'section_rules' AS has FROM documents WHERE id = $1", [plain.documentId])).rows;
    assert.equal(plainDoc?.has, false);
  });
});
