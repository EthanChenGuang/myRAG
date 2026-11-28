import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';

// LANG-11 (plan 07-52): a removal is query-side and deletes nothing; an addition selects only und, scanned and out-of-date
// documents, inside each tenant (0745 rag_language_add_candidates with the 0808 tenant rule).

const SAVED = { RAG_SUPPORTED_LANGUAGES: 'zh,en', RAG_PRIMARY_LANGUAGE: 'zh' } as const;
const ADD = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' } as const;
const REMOVE = { RAG_SUPPORTED_LANGUAGES: 'zh', RAG_PRIMARY_LANGUAGE: 'zh' } as const;

type Row = Record<string, unknown>;
type Role = 'anon' | 'authenticated' | 'service_role';
type Kind = 'und' | 'scanned' | 'stale' | 'current';

let fp: typeof import('@/lib/rag/ingest/fingerprint');
let impact: typeof import('@/lib/rag/ingest/fingerprint/impact');
let plan: typeof import('@/lib/rag/ingest/rebuild/plan');
let run: typeof import('@/lib/rag/ingest/rebuild/run');

function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const result = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return tx.query<Row>(sql, keys.map((key) => args[key]));
        })
        .then((value): RpcResponse => ({ data: value.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

function partsUnder(docType: string, parser: 'docling' | 'llamaparse', languages: Record<string, string>): IngestFingerprintParts {
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
  return fp.expectedFingerprintFor(seed, { ...languages }).parts;
}

interface Doc {
  id: string;
  user: string;
  kind: Kind;
}

/** und: languages {und}; scanned: doc type scanned_image (Docling); stale: LlamaParse under zh,en; current: Docling, detected zh. */
async function insertDoc(db: PGlite, user: string, kind: Kind): Promise<Doc> {
  const id = crypto.randomUUID();
  const docType = kind === 'scanned' ? 'scanned_image' : 'general';
  const parser = kind === 'stale' ? 'llamaparse' : 'docling';
  const parts = partsUnder(docType, parser, SAVED);
  const languages = kind === 'und' ? ['und'] : ['zh'];
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, doc_type, parser_used, ingest_fingerprint, languages)
     VALUES ($1, $2, 'placeholder', $3::jsonb, $4, $1, $5, 'ready', true, $6, $7, $8, $9::text[])`,
    [id, `doc-${id}.md`, JSON.stringify({ ingest_fingerprint_parts: parts }), user, `legacy:${id}`, docType, parser, fp.buildIngestFingerprint(parts), languages],
  );
  return { id, user, kind };
}

async function asRole<T>(db: PGlite, role: Role, body: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await body();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function storeCounts(db: PGlite): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['documents', 'document_chunks', 'document_parents', 'rag_chunk_translations', 'rag_rebuild_runs', 'rag_rebuild_items']) {
    const exists = await db.query<{ present: boolean }>(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`);
    if (!exists.rows[0]?.present) continue;
    const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
    counts[table] = result.rows[0]?.n ?? 0;
  }
  return counts;
}

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`language addition and removal (0745 rag_language_add_candidates, ${mode})`, () => {
    let db: PGlite;
    let rpc: RpcClient;
    const docs: Doc[] = [];
    const userA = mode === 'multi-tenant' ? '00000000-0000-4000-8000-0000000752a1' : '00000000-0000-4000-8000-0000000752c1';
    const userB = '00000000-0000-4000-8000-0000000752b1';
    const tenantA = mode === 'multi-tenant' ? `u:${userA}` : 's:default';
    const tenantB = `u:${userB}`;

    before(async () => {
      Object.assign(process.env, fixtureProcessEnv('http://127.0.0.1:9'), SAVED);
      fp = await import('@/lib/rag/ingest/fingerprint');
      impact = await import('@/lib/rag/ingest/fingerprint/impact');
      plan = await import('@/lib/rag/ingest/rebuild/plan');
      run = await import('@/lib/rag/ingest/rebuild/run');
      (await import('@/lib/rag/lang/settings')).resetLanguageSettingsForTests();
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      const users = mode === 'multi-tenant' ? [userA, userB] : [userA];
      for (const user of users) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, `${user.slice(-4)}@example.invalid`]);
      for (const user of users) for (const kind of ['und', 'scanned', 'stale', 'current'] as Kind[]) docs.push(await insertDoc(db, user, kind));
      rpc = serviceRpc(db);
    });

    beforeEach(() => {
      Object.assign(process.env, SAVED);
    });

    after(async () => {
      await db?.close();
    });

    test('removal deletes nothing: zero affected for every mechanism, no rebuild, every store unchanged', async () => {
      const before = await storeCounts(db);
      const answer = await impact.computeFingerprintImpact({ ...REMOVE }, { db: rpc });
      assert.deepEqual(answer.ingestion_keys, ['RAG_SUPPORTED_LANGUAGES']);
      assert.ok(answer.by_mechanism.every((row) => row.affected === 0), 'a removal-only change affects no document, LlamaParse ones included');
      const coverage = impact.coverageFromGroups(await impact.loadFingerprintGroups({ db: rpc }), { ...REMOVE }, true);
      assert.ok(coverage.pending.every((row) => row.affected === 0), 'after the save no document is left on previous settings');
      const dry = await run.startRebuild({ mechanism: 'reparse', selection: 'language_add', dryRun: true, startedBy: 'test' }, { db: rpc, saved: { ...REMOVE }, ingestAsync: () => true });
      assert.equal(dry.affected, 0);
      assert.deepEqual(await storeCounts(db), before);
    });

    test('an addition selects the und, scanned and out-of-date documents and never a current detected one', async () => {
      const candidates = await run.loadLanguageAddCandidates(rpc, new AbortController().signal);
      const selection = plan.selectLanguageAdd(candidates, { ...ADD });
      const selected = new Set(selection.documents.map((doc) => doc.documentId));
      for (const doc of docs) assert.equal(selected.has(doc.id), doc.kind !== 'current', `${doc.kind} ${doc.user}`);
      const tenants = mode === 'multi-tenant' ? 2 : 1;
      assert.deepEqual(selection.groups, { und: tenants, scanned: tenants, stale: tenants });
    });

    test('an added-and-removed change selects the addition groups only', async () => {
      const candidates = await run.loadLanguageAddCandidates(rpc, new AbortController().signal);
      const selection = plan.selectLanguageAdd(candidates, { RAG_SUPPORTED_LANGUAGES: 'zh,it', RAG_PRIMARY_LANGUAGE: 'zh' });
      const selected = new Set(selection.documents.map((doc) => doc.documentId));
      for (const doc of docs) assert.equal(selected.has(doc.id), doc.kind !== 'current', `${doc.kind} ${doc.user}`);
    });

    test("a tenant's selection never includes another tenant's documents", async () => {
      const candidates = await run.loadLanguageAddCandidates(rpc, new AbortController().signal, tenantA);
      const selection = plan.selectLanguageAdd(candidates, { ...ADD });
      assert.ok(selection.documents.length > 0);
      assert.ok(selection.documents.every((doc) => doc.tenantKey === tenantA));
      const ownIds = new Set(docs.filter((doc) => doc.user === userA).map((doc) => doc.id));
      assert.ok(selection.documents.every((doc) => ownIds.has(doc.documentId)));
      if (mode === 'multi-tenant') {
        const other = plan.selectLanguageAdd(await run.loadLanguageAddCandidates(rpc, new AbortController().signal, tenantB), { ...ADD });
        assert.ok(other.documents.every((doc) => doc.tenantKey === tenantB));
        assert.equal(other.documents.length, 3);
      }
    });

    test('the dry run of a language_add rebuild reports the three groups as one reparse', async () => {
      const dry = await run.startRebuild({ mechanism: 'reparse', selection: 'language_add', dryRun: true, startedBy: 'test' }, { db: rpc, saved: { ...ADD }, ingestAsync: () => true });
      const tenants = mode === 'multi-tenant' ? 2 : 1;
      assert.equal(dry.status, 'dry_run');
      assert.equal(dry.affected, 3 * tenants);
      assert.deepEqual(dry.groups, { und: tenants, scanned: tenants, stale: tenants });
      await assert.rejects(
        run.startRebuild({ mechanism: 'rechunk', selection: 'language_add', dryRun: true, startedBy: 'test' }, { db: rpc, saved: { ...ADD } }),
        (error: unknown) => error instanceof run.RebuildInputError && error.code === 'invalid_selection',
      );
    });

    test('anon and authenticated cannot execute 0745; a key of the other deployment mode is refused', async () => {
      for (const role of ['anon', 'authenticated'] as Role[]) {
        await assert.rejects(
          asRole(db, role, () => db.query('SELECT * FROM public.rag_language_add_candidates(NULL, NULL, 10)')),
          (error: unknown) => (error as { code?: string }).code === '42501',
          role,
        );
      }
      const foreign = mode === 'multi-tenant' ? 's:default' : tenantB;
      await assert.rejects(asRole(db, 'service_role', () => db.query('SELECT * FROM public.rag_language_add_candidates($1, NULL, 10)', [foreign])));
    });
  });
}
