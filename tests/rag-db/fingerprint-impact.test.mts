import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';

const USER_A = '00000000-0000-4000-8000-0000000018a1';
const USER_B = '00000000-0000-4000-8000-0000000018b1';
const TENANT_A = `u:${USER_A}`;
const TENANT_B = `u:${USER_B}`;
const SAVED = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' } as const;

type Row = Record<string, unknown>;
type Role = 'anon' | 'authenticated' | 'service_role';

interface DocSpec {
  user: string;
  docType: string;
  parser?: 'docling' | 'llamaparse';
  fingerprint?: 'parts' | 'none' | 'no_parts';
  status?: string;
  isCurrent?: boolean;
}

let fp: typeof import('@/lib/rag/ingest/fingerprint');
let impact: typeof import('@/lib/rag/ingest/fingerprint/impact');

function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return tx.query<Row>(sql, keys.map((key) => args[key]));
        })
        .then((result): RpcResponse => ({ data: result.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

/** Stored parts of a document published under the saved settings with every switch at its default. */
function storedParts(docType: string, parser: 'docling' | 'llamaparse'): IngestFingerprintParts {
  const seed: IngestFingerprintParts = {
    parser_used: parser,
    parser_version: '1.0.0',
    processing_profile_id: `${docType}@1`,
    processing_profile_version: 1,
    ocr_engine_codes: [],
    chunking_profile_id: 'legacy',
    lexical_version: 2,
    embedding_text_version: 1,
    embedding_profile_id: 'openai-3-small-1536',
    embedding_profile_version: 1,
    language_pack_versions: {},
    switches: { language_aware_ingest: 'off', table_header_repeat: 'profile', table_row_serialization: 'false', caption_language: 'en' },
  };
  return fp.expectedFingerprintFor(seed, { ...SAVED }).parts;
}

async function insertDocs(db: PGlite, specs: DocSpec[]): Promise<void> {
  for (const spec of specs) {
    const id = crypto.randomUUID();
    const mode = spec.fingerprint ?? 'parts';
    const parts = storedParts(spec.docType, spec.parser ?? 'docling');
    const fingerprint = mode === 'none' ? null : mode === 'no_parts' ? 'f'.repeat(64) : fp.buildIngestFingerprint(parts);
    const metadata = mode === 'parts' ? { ingest_fingerprint_parts: parts } : {};
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, doc_type, parser_used, ingest_fingerprint)
       VALUES ($1, $2, 'placeholder', $3::jsonb, $4, $1, $5, $6, $7, $8, $9, $10)`,
      [id, `doc-${id}.md`, JSON.stringify(metadata), spec.user, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.docType, spec.parser ?? 'docling', fingerprint],
    );
  }
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

function affected(answer: { by_mechanism: Array<{ mechanism: string; doc_type: string; affected: number }> }, mechanism: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of answer.by_mechanism) if (row.mechanism === mechanism && row.affected > 0) counts[row.doc_type] = row.affected;
  return counts;
}

describe('ingestion fingerprint impact (0808 rag_fingerprint_groups, computeFingerprintImpact)', () => {
  let db: PGlite;
  let rpc: RpcClient;

  before(async () => {
    Object.assign(process.env, fixtureProcessEnv('http://127.0.0.1:9'), SAVED);
    fp = await import('@/lib/rag/ingest/fingerprint');
    impact = await import('@/lib/rag/ingest/fingerprint/impact');
    (await import('@/lib/rag/lang/settings')).resetLanguageSettingsForTests();
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [USER_A, 'a@example.invalid', USER_B, 'b@example.invalid']);
    rpc = serviceRpc(db);
    await insertDocs(db, [
      { user: USER_A, docType: 'general' },
      { user: USER_A, docType: 'general' },
      { user: USER_A, docType: 'general', parser: 'llamaparse' },
      { user: USER_A, docType: 'financial_report' },
      { user: USER_A, docType: 'contract_legal', parser: 'llamaparse' },
      { user: USER_A, docType: 'invoice_receipt' },
      { user: USER_A, docType: 'general', fingerprint: 'none' },
      { user: USER_A, docType: 'general', fingerprint: 'none' },
      { user: USER_A, docType: 'general', fingerprint: 'no_parts' },
      { user: USER_A, docType: 'general', isCurrent: false },
      { user: USER_A, docType: 'general', status: 'processing' },
      { user: USER_A, docType: 'general', status: 'quarantined' },
      { user: USER_A, docType: 'general', fingerprint: 'none', isCurrent: false },
      { user: USER_B, docType: 'general' },
      { user: USER_B, docType: 'general' },
      { user: USER_B, docType: 'general' },
      { user: USER_B, docType: 'scanned_image', parser: 'llamaparse' },
      { user: USER_B, docType: 'general', fingerprint: 'none' },
    ]);
  });

  beforeEach(() => {
    Object.assign(process.env, SAVED);
  });

  after(async () => {
    await db?.close();
  });

  test('RAG_TABLE_HEADER_REPEAT=always counts the current ready documents of the four profiles whose effective flag changes', async () => {
    const answer = await impact.computeFingerprintImpact({ RAG_TABLE_HEADER_REPEAT: 'always' }, { db: rpc });
    assert.deepEqual(answer.ingestion_keys, ['RAG_TABLE_HEADER_REPEAT']);
    assert.deepEqual(affected(answer, 'rechunk'), { general: 6, contract_legal: 1, scanned_image: 1 });
    assert.equal(answer.by_mechanism.filter((row) => row.mechanism === 'rechunk').length, 6, 'every doc type is listed, zero included');
    assert.ok(answer.by_mechanism.every((row) => row.mechanism === 'rechunk'));
    assert.equal(answer.without_fingerprint, 4);
    assert.equal(answer.total_current, 14);
  });

  test("a tenant's count never includes the other tenant's documents", async () => {
    const a = await impact.computeFingerprintImpact({ RAG_TABLE_HEADER_REPEAT: 'always' }, { db: rpc, tenantKey: TENANT_A });
    assert.deepEqual(affected(a, 'rechunk'), { general: 3, contract_legal: 1 });
    assert.equal(a.without_fingerprint, 3);
    assert.equal(a.total_current, 9);
    const b = await impact.computeFingerprintImpact({ RAG_TABLE_HEADER_REPEAT: 'always' }, { db: rpc, tenantKey: TENANT_B });
    assert.deepEqual(affected(b, 'rechunk'), { general: 3, scanned_image: 1 });
    assert.equal(b.without_fingerprint, 1);
    assert.equal(b.total_current, 5);
  });

  test('a language-set change counts LlamaParse documents and not Docling ones (research F-4)', async () => {
    const answer = await impact.computeFingerprintImpact({ RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'zh' }, { db: rpc });
    assert.deepEqual(answer.ingestion_keys, ['RAG_SUPPORTED_LANGUAGES']);
    assert.deepEqual(affected(answer, 'reparse'), { general: 1, contract_legal: 1, scanned_image: 1 });
  });

  test('exactly one affected document answers 1', async () => {
    const answer = await impact.computeFingerprintImpact({ RAG_SUPPORTED_LANGUAGES: 'zh,en' }, { db: rpc, tenantKey: TENANT_B });
    assert.deepEqual(affected(answer, 'reparse'), { scanned_image: 1 });
    assert.equal(answer.by_mechanism.reduce((sum, row) => sum + row.affected, 0), 1);
  });

  test('proposing the saved values counts 0 for every mechanism', async () => {
    const answer = await impact.computeFingerprintImpact(
      { ...SAVED, RAG_TABLE_HEADER_REPEAT: 'profile', RAG_LANGUAGE_AWARE_INGEST: 'off', RAG_TABLE_ROW_SERIALIZATION: 'false', RAG_CAPTION_LANGUAGE: 'en' },
      { db: rpc },
    );
    assert.deepEqual(answer.ingestion_keys, ['RAG_CAPTION_LANGUAGE', 'RAG_LANGUAGE_AWARE_INGEST', 'RAG_SUPPORTED_LANGUAGES', 'RAG_TABLE_HEADER_REPEAT', 'RAG_TABLE_ROW_SERIALIZATION']);
    assert.ok(answer.by_mechanism.length > 0);
    assert.ok(answer.by_mechanism.every((row) => row.affected === 0));
    assert.equal(answer.without_fingerprint, 4);
  });

  test('a query-side key returns no ingestion key and no affected document', async () => {
    const answer = await impact.computeFingerprintImpact({ RAG_RERANKER: 'cohere' }, { db: rpc });
    assert.deepEqual(answer.ingestion_keys, []);
    assert.deepEqual(answer.by_mechanism, []);
    assert.equal(answer.total_current, 14);
  });

  test('the switches of each mechanism count under their own mechanism', async () => {
    const answer = await impact.computeFingerprintImpact({ RAG_CAPTION_LANGUAGE: 'document', RAG_TABLE_ROW_SERIALIZATION: 'true' }, { db: rpc, tenantKey: TENANT_B });
    assert.deepEqual(affected(answer, 'recaption'), { general: 3, scanned_image: 1 });
    assert.deepEqual(affected(answer, 'rechunk'), { general: 3, scanned_image: 1 });
  });

  test('the groups are aggregates only: no document id, tenant key or text column', async () => {
    const result = await asRole(db, 'service_role', () => db.query<Row>('SELECT * FROM public.rag_fingerprint_groups(NULL)'));
    const columns = new Set(result.rows.flatMap((row) => Object.keys(row)));
    assert.deepEqual([...columns].sort(), ['doc_type', 'documents', 'ingest_fingerprint', 'parts']);
  });

  test('anon and authenticated cannot execute the 0808 functions; a key of the other deployment mode is refused', async () => {
    for (const role of ['anon', 'authenticated'] as Role[]) {
      for (const sql of [
        'SELECT * FROM public.rag_fingerprint_groups(NULL)',
        'SELECT * FROM public.rag_fingerprint_backfill_page(NULL, 10, NULL)',
        `SELECT public.rag_fingerprint_backfill_write('${TENANT_A}', gen_random_uuid(), '${'a'.repeat(64)}', '{}'::jsonb)`,
      ]) {
        await assert.rejects(asRole(db, role, () => db.query(sql)), (error: unknown) => (error as { code?: string }).code === '42501', `${role}: ${sql}`);
      }
    }
    await assert.rejects(asRole(db, 'service_role', () => db.query("SELECT * FROM public.rag_fingerprint_groups('s:default')")));
  });
});
