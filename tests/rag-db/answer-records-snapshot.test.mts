import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

const PROFILE = 'p256-snapshot';
const PUBLISH_PATH = '/rest/v1/rpc/rag_publish_document_version';
const TENANT_KEY = `u:${TWO_TENANT_IDS.userA}`;
const SOURCE_KEY = 'root/snapshot-policy.md';
const FILENAME = 'snapshot-policy.md';

type Row = Record<string, unknown>;

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

function contractText(label: string, warranty: string): string {
  return [
    `# Supply Agreement ${label}`,
    '',
    '## 1. Definitions',
    '',
    `In this agreement ${label} means the buyer and the supplier of forklifts and pallets named in the schedule.`,
    '',
    '## 2. Delivery',
    '',
    `The supplier shall deliver the equipment of ${label} within thirty days of the order and shall bear the transport risk.`,
    '',
    '## 3. Warranty',
    '',
    warranty,
    '',
    '## 4. Termination',
    '',
    `Either party may terminate ${label} with ninety days of written notice when the other party breaches a material clause.`,
    '',
  ].join('\n');
}

describe('citationDisplayEntries', () => {
  test('returns one entry per citation in n order and marks documents that are not current', async () => {
    const { citationDisplayEntries } = await import('@/lib/citations/display');
    const base = { chunkIds: ['c'], documentVersion: 1, quoteHash: 'a'.repeat(64), strategy: 'chunk-alias' as const };
    const citations: CitationRecord[] = [
      { ...base, n: 2, alias: 'S2', documentId: 'doc-b', documentName: 'b.md', page: null, sectionPath: null, quote: 'quote b' },
      { ...base, n: 1, alias: 'S1', documentId: 'doc-a', documentName: 'a.md', page: 4, sectionPath: ['A', 'B'], quote: 'quote a' },
      { ...base, n: 3, alias: 'S3', documentId: 'doc-c', documentName: 'c.md', page: null, sectionPath: null, quote: 'quote c' },
    ];
    assert.deepEqual(citationDisplayEntries(citations, { 'doc-a': 'current', 'doc-b': 'unavailable' }), [
      { n: 1, documentName: 'a.md', page: 4, sectionPath: ['A', 'B'], quote: 'quote a', linkDocumentId: 'doc-a', unavailable: false },
      { n: 2, documentName: 'b.md', page: null, sectionPath: null, quote: 'quote b', linkDocumentId: null, unavailable: true },
      { n: 3, documentName: 'c.md', page: null, sectionPath: null, quote: 'quote c', linkDocumentId: null, unavailable: true },
    ]);
    assert.equal(citations[0]?.n, 2, 'the input is not reordered in place');
  });
});

describe('answer-record citation snapshots survive document changes (multi-tenant)', () => {
  let fixture: TwoTenantDatabase;
  let edge: import('../../eval/harness/fake-edge.mts').FakeEdge;
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let activeModule: typeof import('@/lib/rag/embeddings/active-profile');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let rechunk: typeof import('@/lib/rag/ingest/rechunk/run');
  let store: typeof import('@/lib/answers/store');
  let read: typeof import('@/lib/answers/read');
  let display: typeof import('@/lib/citations/display');
  let contracts: typeof import('@/lib/rag-eval/contracts.generated');
  const realFetch = globalThis.fetch;
  const answerId = crypto.randomUUID();
  let documentId = '';
  let lineageId = '';
  let citations: CitationRecord[] = [];
  let snapshot = '';

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const scopeA = (): TenantScope => scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null);
  const recordBytes = async (): Promise<string> =>
    String((await rows('SELECT row_to_json(r)::text AS bytes FROM rag_answer_records r WHERE id = $1', [answerId]))[0]?.bytes);

  async function upload(warranty: string) {
    const result = await ingestModule.ingest({
      scope: scopeA(),
      source: 'config_upload',
      sourceKey: SOURCE_KEY,
      text: contractText('snapshot', warranty),
      filename: FILENAME,
      mimeType: 'text/markdown',
      docType: 'contract_legal',
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'ready');
    return String(result.documentId);
  }

  async function entries() {
    const session = createPgliteAdmin(fixture.db, { asUser: TWO_TENANT_IDS.userA, jsonColumns: ['citations', 'groundedness', 'feedback'] }) as unknown as SupabaseClient;
    const row = await store.readOwnedAnswerRecord(session, { id: answerId, userId: TWO_TENANT_IDS.userA });
    assert.ok(row, 'the owner still reads the record');
    const documents = await read.documentStatuses(session, read.citedDocumentIds(row));
    const record = contracts.AnswerRecordSchema.parse(read.toAnswerRecord(row, new Date(), documents, { feedbackEnabled: false }));
    return { record, entries: display.citationDisplayEntries(record.citations ?? [], record.documents ?? {}) };
  }

  async function assertSurvives(step: string, availability: 'current' | 'unavailable') {
    assert.equal(await recordBytes(), snapshot, `${step}: the stored record is byte-identical`);
    const { record, entries: shown } = await entries();
    assert.deepEqual(record.citations, citations, `${step}: the citation snapshot is unchanged`);
    assert.deepEqual(record.documents, { [documentId]: availability }, step);
    assert.deepEqual(
      shown,
      citations.map((citation) => ({
        n: citation.n,
        documentName: FILENAME,
        page: citation.page,
        sectionPath: citation.sectionPath,
        quote: citation.quote,
        linkDocumentId: availability === 'current' ? documentId : null,
        unavailable: availability === 'unavailable',
      })),
      `${step}: quote, name and number still render`,
    );
  }

  before(async () => {
    const { fixtureProcessEnv, startFakeEdge } = await import('../../eval/harness/fake-edge.mts');
    const emptyCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-snapshot-corpus-'));
    try {
      fixture = await createTwoTenantDatabase({ corpusDir: emptyCorpus });
    } finally {
      fs.rmdirSync(emptyCorpus);
    }
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(edge.url)) throw new Error(`unexpected outbound request: ${url}`);
      return realFetch(input, init);
    }) as typeof fetch;
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    activeModule = await import('@/lib/rag/embeddings/active-profile');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    ingestModule = await import('@/lib/rag/ingest');
    scopeModule = await import('@/lib/rag/tenant/scope');
    rechunk = await import('@/lib/rag/ingest/rechunk/run');
    store = await import('@/lib/answers/store');
    read = await import('@/lib/answers/read');
    display = await import('@/lib/citations/display');
    contracts = await import('@/lib/rag-eval/contracts.generated');
    objectStoreModule.setObjectStoreForTests((await import('../helpers/fake-object-store')).createFakeObjectStore());
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'off' }),
      embedDocuments: async (texts) => texts.map((text, index) => vector(1536, text.length + index)),
    });
    activeModule.resetActiveProfileForTests();
    await fixture.db.query(
      `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
       VALUES ($1, 'contract_legal', 256, 'structure', 1024, 'building', '256/1024') ON CONFLICT DO NOTHING`,
      [PROFILE],
    );

    documentId = await upload('The supplier warrants every forklift for twelve months. Defects reported inside that period are repaired at no charge.');
    const doc = (await rows('SELECT lineage_id, version FROM documents WHERE id = $1', [documentId]))[0];
    lineageId = String(doc?.lineage_id);
    assert.equal(Number(doc?.version), 1);
    const chunks = await rows(
      "SELECT id, content, section_path FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'legacy' ORDER BY chunk_index",
      [documentId],
    );
    assert.ok(chunks.length >= 2, 'version 1 has chunks');
    citations = chunks.slice(0, 2).map((chunk, index) => {
      const quote = String(chunk.content).slice(0, 160);
      return {
        n: index + 1,
        alias: `S${index + 1}`,
        chunkIds: [String(chunk.id)],
        documentId,
        documentName: FILENAME,
        documentVersion: 1,
        page: null,
        sectionPath: Array.isArray(chunk.section_path) ? (chunk.section_path as string[]) : null,
        quote,
        quoteHash: crypto.createHash('sha256').update(quote).digest('hex'),
        strategy: 'chunk-alias' as const,
      };
    });
    const admin = createPgliteAdmin(fixture.db, { jsonColumns: ['citations', 'groundedness', 'feedback'] }) as unknown as SupabaseClient;
    const inserted = await store.insertAnswerRecord(admin, {
      id: answerId,
      scope: scopeA(),
      userId: TWO_TENANT_IDS.userA,
      chatId: null,
      traceId: 'trace-snapshot',
      modelId: 'placeholder/model',
      citationStrategy: 'chunk-alias',
      ragMode: 'strict',
      answerLanguage: 'en',
      invalidCitations: 0,
      citations,
      groundedness: { status: 'pending', scorer: null, score: null, label: null, threshold: null, thresholdSource: null, reason: null, truncated: false, latencyMs: null, checkedAt: null },
    });
    assert.deepEqual(inserted, { inserted: true });
    snapshot = await recordBytes();
  });

  after(async () => {
    globalThis.fetch = realFetch;
    objectStoreModule?.resetObjectStoreForTests();
    depsModule?.resetIngestDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('the fresh record renders its citations with the document current', async () => {
    await assertSurvives('fresh', 'current');
  });

  test('after runRechunkBatch rebuilds the document under another chunking profile', async () => {
    const scopeFor = async (tenantKey: string): Promise<TenantScope | null> => (tenantKey === TENANT_KEY ? scopeA() : null);
    const db = depsModule.getIngestDeps().db() as RpcClient;
    for (let call = 0; call < 10; call += 1) {
      const report = await rechunk.runRechunkBatch({ db, profileId: PROFILE, scopeFor });
      if (!report.more) break;
    }
    const rebuilt = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2', [documentId, PROFILE]);
    assert.ok(Number(rebuilt[0]?.n) > 0, 'the document has chunks under the new profile');
    await assertSurvives('re-chunk', 'current');
  });

  test('after rag_publish_document_version publishes version 2', async () => {
    edge.calls.length = 0;
    const second = await upload('The supplier warrants every forklift for twenty-four months, parts and labour included, from the delivery date.');
    assert.notEqual(second, documentId);
    assert.ok(edge.calls.some((call) => call.path === PUBLISH_PATH), 'version 2 went through rag_publish_document_version');
    const versions = await rows('SELECT id, version, is_current FROM documents WHERE lineage_id = $1 ORDER BY version', [lineageId]);
    assert.deepEqual(
      versions.map((row) => [Number(row.version), row.is_current]),
      [
        [1, false],
        [2, true],
      ],
    );
    await assertSurvives('publish v2', 'unavailable');
  });

  test('after rag_soft_delete_document', async () => {
    const outcome = await rows('SELECT * FROM rag_soft_delete_document($1, $2::uuid, $3)', [TENANT_KEY, lineageId, 'config_upload']);
    assert.equal(outcome[0]?.outcome, 'deleted');
    const live = await rows("SELECT count(*)::int AS n FROM documents WHERE lineage_id = $1 AND (is_current OR status <> 'deleted')", [lineageId]);
    assert.equal(Number(live[0]?.n), 0);
    await assertSurvives('soft delete', 'unavailable');
  });

  test('after a hard DELETE of the documents rows', async () => {
    await fixture.db.query('DELETE FROM ingestion_jobs WHERE lineage_id = $1', [lineageId]);
    await fixture.db.query('DELETE FROM documents WHERE lineage_id = $1', [lineageId]);
    assert.equal((await rows('SELECT id FROM documents WHERE id = $1', [documentId])).length, 0);
    assert.equal((await rows('SELECT id FROM document_chunks WHERE document_id = $1', [documentId])).length, 0);
    await assertSurvives('hard delete', 'unavailable');
  });
});
