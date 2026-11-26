import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { IngestFingerprintPartsSchema } from '@/lib/rag-eval/contracts.generated';

const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const TENANT_O = `o:${TWO_TENANT_IDS.orgO}`;
/** 19 fixture corpus documents of the fixture user plus the three canary documents, all published before Phase 3.2. */
const DOCUMENTS = 22;
const SENTINEL = 'c'.repeat(64);

type Row = Record<string, unknown>;

let backfill: typeof import('@/lib/rag/ingest/fingerprint/backfill');
let cli: typeof import('@/lib/rag/ingest/fingerprint/cli');
let fp: typeof import('@/lib/rag/ingest/fingerprint');

function serviceRpc(db: PGlite, calls: string[] = []): RpcClient {
  return {
    rpc(fn, args) {
      calls.push(fn);
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return tx.query<Row>(sql, keys.map((key) => (key === 'p_parts' ? JSON.stringify(args[key]) : args[key])));
        })
        .then((result): RpcResponse => ({ data: result.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

async function fingerprinted(db: PGlite): Promise<number> {
  return Number((await db.query<Row>('SELECT count(*)::int AS n FROM documents WHERE ingest_fingerprint IS NOT NULL')).rows[0]?.n);
}

async function documentState(db: PGlite): Promise<string> {
  const rows = await db.query<Row>('SELECT id, ingest_fingerprint, metadata FROM documents ORDER BY id');
  return JSON.stringify(rows.rows);
}

describe('rag:fingerprint backfill (src/lib/rag/ingest/fingerprint/backfill.ts)', () => {
  let fixture: TwoTenantDatabase;
  let fetchCalls: string[];
  const realFetch = globalThis.fetch;

  before(async () => {
    Object.assign(process.env, fixtureProcessEnv('http://127.0.0.1:9'));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    fp = await import('@/lib/rag/ingest/fingerprint');
    backfill = await import('@/lib/rag/ingest/fingerprint/backfill');
    cli = await import('@/lib/rag/ingest/fingerprint/cli');
    fixture = await createTwoTenantDatabase();
  });

  beforeEach(async () => {
    await fixture.db.query(
      `UPDATE documents SET ingest_fingerprint = NULL, metadata = coalesce(metadata, '{}'::jsonb) - 'ingest_fingerprint_parts'`,
    );
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error('the backfill must not call the network');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await fixture?.db.close();
  });

  test('every pre-phase document gets a fingerprint from stored columns, with zero parser, embedding or network calls', async () => {
    const calls: string[] = [];
    const report = await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db, calls), pageSize: 5 });
    assert.equal(report.updated, DOCUMENTS);
    assert.equal(report.skipped, 0);
    assert.equal(report.complete, true);
    assert.deepEqual(report.tenants, { [TENANT_O]: 1, [TENANT_A]: 1, [TENANT_B]: 1, [`u:${'00000000-0000-4000-8000-0000000000f1'}`]: 19 });
    assert.equal(await fingerprinted(fixture.db), DOCUMENTS);
    assert.deepEqual(fetchCalls, []);
    assert.deepEqual([...new Set(calls)].sort(), ['rag_fingerprint_backfill_page', 'rag_fingerprint_backfill_write']);

    const rows = await fixture.db.query<Row>('SELECT doc_type, ingest_fingerprint, metadata FROM documents');
    for (const row of rows.rows) {
      const parts = IngestFingerprintPartsSchema.parse((row.metadata as Row).ingest_fingerprint_parts);
      assert.equal(row.ingest_fingerprint, fp.buildIngestFingerprint(parts));
      assert.equal(parts.parser_used, 'llamaparse');
      assert.equal(parts.parser_version, 'legacy');
      assert.equal(parts.processing_profile_id, `${row.doc_type}@1`);
      assert.equal(parts.chunking_profile_id, 'legacy');
      assert.equal(parts.lexical_version, 2);
      assert.equal(parts.embedding_text_version, 0);
      assert.equal(parts.embedding_profile_id, 'openai-3-small-1536');
      assert.deepEqual(parts.switches, { language_aware_ingest: 'off', table_header_repeat: 'profile', table_row_serialization: 'false', caption_language: 'en' });
      assert.deepEqual(parts.assumed_defaults, [
        'processing_profile_id',
        'processing_profile_version',
        'ocr_engine_codes',
        'language_pack_versions',
        'switches',
      ]);
    }
  });

  test('a backfilled document is unaffected by the saved defaults and counted by the impact query', async () => {
    await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db) });
    const impact = await import('@/lib/rag/ingest/fingerprint/impact');
    const none = await impact.computeFingerprintImpact({ RAG_TABLE_HEADER_REPEAT: 'profile' }, { db: serviceRpc(fixture.db) });
    assert.equal(none.without_fingerprint, 0);
    assert.ok(none.by_mechanism.every((row) => row.affected === 0));
  });

  test('--dry-run writes nothing and reports the per-tenant counts', async () => {
    const before = await documentState(fixture.db);
    const report = await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db), dryRun: true, pageSize: 4 });
    assert.equal(report.dryRun, true);
    assert.equal(report.updated, 0);
    assert.equal(Object.values(report.tenants).reduce((sum, count) => sum + count, 0), DOCUMENTS);
    assert.equal(await documentState(fixture.db), before);
  });

  test('a second run updates 0 documents', async () => {
    await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db) });
    const state = await documentState(fixture.db);
    const second = await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db) });
    assert.equal(second.updated, 0);
    assert.deepEqual(second.tenants, {});
    assert.equal(await documentState(fixture.db), state);
  });

  test('a run stopped after one page continues with the rest and never rewrites a finished document', async () => {
    const stamped = await fixture.db.query<Row>('SELECT id FROM documents ORDER BY id DESC LIMIT 1');
    const stampedId = stamped.rows[0]?.id as string;
    await fixture.db.query(
      `UPDATE documents SET ingest_fingerprint = $2, metadata = coalesce(metadata, '{}'::jsonb) || '{"ingest_fingerprint_parts": {"marker": 1}}'::jsonb WHERE id = $1`,
      [stampedId, SENTINEL],
    );
    const first = await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db), pageSize: 3, maxPages: 1 });
    assert.equal(first.updated, 3);
    assert.equal(first.complete, false);
    assert.equal(await fingerprinted(fixture.db), 4);
    const rest = await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db), pageSize: 3 });
    assert.equal(rest.updated, DOCUMENTS - 4);
    assert.equal(rest.complete, true);
    const after = await fixture.db.query<Row>('SELECT ingest_fingerprint, metadata FROM documents WHERE id = $1', [stampedId]);
    assert.equal(after.rows[0]?.ingest_fingerprint, SENTINEL);
    assert.deepEqual((after.rows[0]?.metadata as Row).ingest_fingerprint_parts, { marker: 1 });
  });

  test('--tenant limits the backfill to that tenant', async () => {
    const report = await backfill.runFingerprintBackfill({ db: serviceRpc(fixture.db), tenantKey: TENANT_B });
    assert.deepEqual(report.tenants, { [TENANT_B]: 1 });
    const rows = await fixture.db.query<Row>('SELECT tenant_key FROM documents WHERE ingest_fingerprint IS NOT NULL');
    assert.deepEqual(rows.rows.map((row) => row.tenant_key), [TENANT_B]);
  });

  test('a write for another tenant or an already stamped document changes nothing', async () => {
    const doc = TWO_TENANT_IDS.docA;
    const write = (tenant: string) =>
      serviceRpc(fixture.db).rpc('rag_fingerprint_backfill_write', { p_tenant_key: tenant, p_document_id: doc, p_fingerprint: 'a'.repeat(64), p_parts: { x: 1 } });
    assert.deepEqual((await write(TENANT_B)).data, [{ rag_fingerprint_backfill_write: false }]);
    assert.deepEqual((await write(TENANT_A)).data, [{ rag_fingerprint_backfill_write: true }]);
    const again = await serviceRpc(fixture.db).rpc('rag_fingerprint_backfill_write', {
      p_tenant_key: TENANT_A,
      p_document_id: doc,
      p_fingerprint: 'b'.repeat(64),
      p_parts: { x: 2 },
    });
    assert.deepEqual(again.data, [{ rag_fingerprint_backfill_write: false }]);
  });

  test('the CLI prints counts per tenant on a dry run and refuses bad arguments with exit 2', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    const code = await cli.main(['backfill', '--dry-run', '--page-size', '10'], io, undefined, { db: serviceRpc(fixture.db) });
    assert.equal(code, 0);
    assert.ok(out.includes('[RAG Fingerprint] dry run, nothing written'));
    assert.ok(out.includes(`[RAG Fingerprint] ${TENANT_B}: would update 1`));
    assert.ok(out.includes(`[RAG Fingerprint] total: would update ${DOCUMENTS}`));
    assert.equal(await fingerprinted(fixture.db), 0);

    for (const argv of [[], ['rebuild'], ['backfill', '--page-size', '0'], ['backfill', '--tenant', 'nobody'], ['backfill', '--dry-run', '--dry-run'], ['backfill', '--unknown']]) {
      assert.equal(await cli.main(argv, io, undefined, { db: serviceRpc(fixture.db) }), 2, argv.join(' '));
    }
  });
});

describe('partsFromStoredRow', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000001801',
    tenant_key: 's:default',
    doc_type: 'general',
    parser_used: 'docling',
    parser_version: '2.1.0',
    processing_profile_id: 'general@1',
    processing_profile_version: 1,
    chunking_profile_ids: ['legacy'],
    lexical_version: 2,
    embedding_text_version: 1,
    embedding_profile_ids: [] as string[],
    has_legacy_vectors: true,
    ocr_languages: null as unknown,
  };

  test('the OCR languages of a queued run come from its settings snapshot and are not assumed', () => {
    const parts = backfill.partsFromStoredRow({ ...base, ocr_languages: ['en', 'it'] }, { embeddingProfileId: 'openai-3-small-1536' });
    assert.deepEqual(parts.ocr_engine_codes, fp.ocrEngineCodes('docling', ['en', 'it']));
    assert.deepEqual(parts.assumed_defaults, ['switches']);
  });

  test('an inline run assumes the profile OCR languages', () => {
    const parts = backfill.partsFromStoredRow(base, { embeddingProfileId: 'openai-3-small-1536' });
    assert.deepEqual(parts.ocr_engine_codes, fp.ocrEngineCodes('docling', ['zh', 'en', 'it']));
    assert.deepEqual(parts.assumed_defaults, ['ocr_engine_codes', 'language_pack_versions', 'switches']);
  });

  test('the embedding profile is the preferred one when the document has its vectors, else the one it has', () => {
    const profiled = { ...base, has_legacy_vectors: false, embedding_profile_ids: ['profile-b', 'profile-c'] };
    assert.equal(backfill.partsFromStoredRow(profiled, { embeddingProfileId: 'profile-c' }).embedding_profile_id, 'profile-c');
    assert.equal(backfill.partsFromStoredRow(profiled, { embeddingProfileId: 'openai-3-small-1536' }).embedding_profile_id, 'profile-b');
    const bare = backfill.partsFromStoredRow({ ...base, has_legacy_vectors: false, chunking_profile_ids: [], lexical_version: null, embedding_text_version: null }, {
      embeddingProfileId: 'openai-3-small-1536',
    });
    assert.equal(bare.embedding_profile_id, 'openai-3-small-1536');
    assert.ok(bare.assumed_defaults?.includes('embedding_profile_id'));
    assert.ok(bare.assumed_defaults?.includes('lexical_version'));
    assert.ok(bare.assumed_defaults?.includes('chunking_profile_id'));
  });

  test('missing parser columns are recorded as assumed', () => {
    const parts = backfill.partsFromStoredRow({ ...base, parser_used: null, parser_version: null }, { embeddingProfileId: 'openai-3-small-1536' });
    assert.equal(parts.parser_used, 'unknown');
    assert.deepEqual(parts.ocr_engine_codes, []);
    assert.ok(parts.assumed_defaults?.includes('parser_used'));
    assert.ok(parts.assumed_defaults?.includes('parser_version'));
  });
});
