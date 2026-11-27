import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0976_rag_purge_hook_golden_items.sql';
const PHASE_FILE = /^supabase\/migrations\/09[67]\d_/;
const REQUIRES_RETRIEVAL_LOG = /^supabase\/migrations\/0966_/;
const USER_A = '00000000-0000-4000-8000-0000000052a1';
const USER_B = '00000000-0000-4000-8000-0000000052b1';
const LABELLER = '00000000-0000-4000-8000-0000000052c1';
const SET = 'set-1';
const NIL = '00000000-0000-0000-0000-000000000000';
const ZERO_HASH = '0'.repeat(64);

type Role = 'anon' | 'authenticated' | 'service_role';

interface EvidenceRow {
  tenant_key: string;
  item_id: string;
  document_id: string;
  quote_sha256: string;
  needs_check: boolean;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function insertDoc(db: PGlite, userId: string, lineageId?: string, version = 1, isCurrent = true): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, version)
     VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $4, $5, 'ready', $6, $7)`,
    [id, `doc-${id}.md`, userId, lineageId ?? id, `legacy:${lineageId ?? id}`, isCurrent, version],
  );
  return id;
}

async function register(db: PGlite, tenantKey: string, rows: unknown[]): Promise<{ stored: number; dropped: number }> {
  const r = await db.query<{ stored: number; dropped: number }>(
    'SELECT stored, dropped FROM public.rag_golden_evidence_register($1, $2, $3::jsonb)',
    [tenantKey, SET, JSON.stringify(rows)],
  );
  return r.rows[0]!;
}

async function hook(db: PGlite, tenantKey: string, lineageId: string | null, documentIds: string[]): Promise<number> {
  const r = await db.query<{ n: string | number }>('SELECT public.rag_purge_hook_golden_items($1, $2, $3::uuid[]) AS n', [
    tenantKey,
    lineageId,
    documentIds,
  ]);
  return Number(r.rows[0]!.n);
}

async function evidence(db: PGlite): Promise<EvidenceRow[]> {
  const r = await db.query<EvidenceRow>(
    `SELECT tenant_key, item_id, document_id::text AS document_id, quote_sha256, needs_check
       FROM public.rag_golden_evidence_index ORDER BY tenant_key, item_id, document_id, quote_sha256`,
  );
  return r.rows;
}

async function pending(db: PGlite, tenantKey: string): Promise<string[]> {
  const r = await db.query<{ item_id: string }>('SELECT item_id FROM public.rag_golden_evidence_pending($1, $2) AS item_id', [tenantKey, SET]);
  return r.rows.map((row) => row.item_id).sort();
}

async function insertItem(db: PGlite, tenantKey: string, candidates: unknown[]): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, query_masked, query_fingerprint, reasons, mining_window, candidates)
     VALUES ($1, 'A synthetic question about the sample topic', $2, '{low_score}', '2026-11-23T00:00:00Z', $3::jsonb) RETURNING id`,
    [tenantKey, sha(crypto.randomUUID()), JSON.stringify(candidates)],
  );
  return r.rows[0]!.id;
}

async function label(db: PGlite, itemId: string, tenantKey: string): Promise<void> {
  await db.query(
    `INSERT INTO rag_judge_labels (review_item_id, tenant_key, supported, relevant, unsupported_content, labelled_by)
     VALUES ($1, $2, true, true, false, $3)`,
    [itemId, tenantKey, LABELLER],
  );
}

async function labelledItems(db: PGlite): Promise<string[]> {
  const r = await db.query<{ review_item_id: string }>('SELECT review_item_id FROM rag_judge_labels ORDER BY review_item_id');
  return r.rows.map((row) => row.review_item_id).sort();
}

function candidate(documentId: unknown, kept?: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = { chunk_id: crypto.randomUUID(), document_id: documentId, rank: 1, similarity: 0.5 };
  if (kept !== undefined) entry.kept = kept;
  return entry;
}

function findCount(value: unknown, key: string): number {
  if (value === null || typeof value !== 'object') return -1;
  const record = value as Record<string, unknown>;
  if (key in record) return Number(record[key]);
  for (const nested of Object.values(record)) {
    const found = findCount(nested, key);
    if (found >= 0) return found;
  }
  return -1;
}

async function resetData(db: PGlite): Promise<void> {
  await db.exec(`
    DELETE FROM public.rag_golden_evidence_index;
    DO $$ BEGIN
      IF to_regclass('public.rag_judge_labels') IS NOT NULL THEN DELETE FROM public.rag_judge_labels; END IF;
      IF to_regclass('public.rag_review_items') IS NOT NULL THEN DELETE FROM public.rag_review_items; END IF;
    END $$;
    DELETE FROM documents;
  `);
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const TENANT_A = multi ? `u:${USER_A}` : 's:default';
  const TENANT_B = `u:${USER_B}`;
  const OTHER_MODE_KEY = multi ? 's:default' : `u:${USER_A}`;

  describe(`rag_purge_hook_golden_items 0976 (${mode})`, () => {
    let db: PGlite;
    let lineage: string;
    let v1: string;
    let v2: string;
    let d2: string;
    let docB: string;
    let r1: string;
    let r2: string;
    let r3: string;
    let r4: string;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
        USER_A,
        'tenant-a@example.invalid',
        USER_B,
        'tenant-b@example.invalid',
        LABELLER,
        'labeller@example.invalid',
      ]);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await resetData(db);
      lineage = crypto.randomUUID();
      v1 = await insertDoc(db, USER_A, lineage, 1, false);
      v2 = await insertDoc(db, USER_A, lineage, 2, true);
      d2 = await insertDoc(db, USER_A);
      assert.deepEqual(
        await register(db, TENANT_A, [
          { item_id: 'i1', document_id: v1, quote_sha256: sha('first synthetic quote') },
          { item_id: 'i2', document_id: v2, quote_sha256: sha('second synthetic quote') },
          { item_id: 'i2', document_id: d2, quote_sha256: sha('third synthetic quote') },
          { item_id: 'i3', document_id: d2, quote_sha256: sha('fourth synthetic quote') },
        ]),
        { stored: 4, dropped: 0 },
      );
      if (multi) {
        docB = await insertDoc(db, USER_B);
        assert.deepEqual(await register(db, TENANT_B, [{ item_id: 'b1', document_id: docB, quote_sha256: sha('foreign synthetic quote') }]), {
          stored: 1,
          dropped: 0,
        });
      } else {
        docB = crypto.randomUUID();
        await db.query(
          `INSERT INTO public.rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256) VALUES ($1, $2, 'b1', $3, $4)`,
          [TENANT_B, SET, docB, sha('foreign synthetic quote')],
        );
      }
      // A row of the other tenant that names the same document id: only the tenant predicate keeps it.
      await db.query(
        `INSERT INTO public.rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256) VALUES ($1, $2, 'b2', $3, $4)`,
        [TENANT_B, SET, v1, sha('foreign twin synthetic quote')],
      );

      r1 = await insertItem(db, TENANT_A, [candidate(v1, true), candidate(d2, false)]);
      r2 = await insertItem(db, TENANT_A, [candidate(v1, false), candidate(d2, true)]);
      r3 = await insertItem(db, TENANT_A, [candidate(d2, true), candidate(42, true), 'not-an-object', candidate(null)]);
      r4 = await insertItem(db, TENANT_B, [candidate(v1, true)]);
      for (const [item, tenant] of [
        [r1, TENANT_A],
        [r2, TENANT_A],
        [r3, TENANT_A],
        [r4, TENANT_B],
      ] as const) {
        await label(db, item, tenant);
      }
    });

    test('the hook is invoker with an empty search_path and service_role only', async () => {
      const r = await db.query<{ prosecdef: boolean; proconfig: string[] | null; anon: boolean; authenticated: boolean; service_role: boolean }>(
        `SELECT p.prosecdef, p.proconfig,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
           FROM pg_proc p WHERE p.oid = 'public.rag_purge_hook_golden_items(text, uuid, uuid[])'::regprocedure`,
      );
      const row = r.rows[0]!;
      assert.equal(row.prosecdef, false);
      assert.ok((row.proconfig ?? []).includes('search_path=""'), JSON.stringify(row.proconfig));
      assert.deepEqual([row.anon, row.authenticated, row.service_role], [false, false, true]);
    });

    test('purging a lineage deletes its evidence rows, leaves tombstones and flags the affected items', async () => {
      const deleted = await asRole(db, 'service_role', () => hook(db, TENANT_A, lineage, [v1, v2]));
      assert.equal(deleted, 3, 'two evidence rows and one label');
      const rows = await evidence(db);
      const rowsA = rows.filter((row) => row.tenant_key === TENANT_A);
      assert.deepEqual(
        rowsA.filter((row) => row.document_id === v1 || row.document_id === v2),
        [],
        'no row of the tenant keeps a purged version id',
      );
      const tombstones = rowsA.filter((row) => row.document_id === NIL);
      assert.deepEqual(
        tombstones.map((row) => [row.item_id, row.quote_sha256, row.needs_check]),
        [
          ['i1', ZERO_HASH, true],
          ['i2', ZERO_HASH, true],
        ],
      );
      const i2Remaining = rowsA.find((row) => row.item_id === 'i2' && row.document_id === d2);
      assert.equal(i2Remaining?.needs_check, true);
      const i3 = rowsA.find((row) => row.item_id === 'i3');
      assert.equal(i3?.needs_check, false);
      assert.deepEqual(await pending(db, TENANT_A), ['i1', 'i2']);
      assert.deepEqual(await labelledItems(db), [r2, r3, r4].sort(), "only r1's label goes");
    });

    test('a second identical call returns 0 and changes nothing', async () => {
      await hook(db, TENANT_A, lineage, [v1, v2]);
      const beforeRows = await evidence(db);
      const beforeLabels = await labelledItems(db);
      assert.equal(await hook(db, TENANT_A, lineage, [v1, v2]), 0);
      assert.deepEqual(await evidence(db), beforeRows);
      assert.deepEqual(await labelledItems(db), beforeLabels);
    });

    test('the lineage alone finds every version still present', async () => {
      assert.equal(await hook(db, TENANT_A, lineage, []), 3);
      const rowsA = (await evidence(db)).filter((row) => row.tenant_key === TENANT_A);
      assert.deepEqual(rowsA.filter((row) => row.document_id === v1 || row.document_id === v2), []);
    });

    test('document ids alone are purged when the lineage rows are already gone', async () => {
      await db.query('DELETE FROM documents WHERE lineage_id = $1', [lineage]);
      assert.equal(await hook(db, TENANT_A, lineage, [v1]), 2, 'the v1 evidence row and the r1 label');
      const rowsA = (await evidence(db)).filter((row) => row.tenant_key === TENANT_A);
      assert.deepEqual(rowsA.filter((row) => row.document_id === v1), []);
      assert.ok(rowsA.some((row) => row.document_id === v2), 'v2 was neither named nor found through the lineage');
    });

    test('a candidate without a kept field counts as kept', async () => {
      const r5 = await insertItem(db, TENANT_A, [candidate(v2)]);
      await label(db, r5, TENANT_A);
      assert.equal(await hook(db, TENANT_A, lineage, [v1, v2]), 4);
      assert.ok(!(await labelledItems(db)).includes(r5));
    });

    test('rows of another tenant stay, including a row naming the same document id', async () => {
      await hook(db, TENANT_A, lineage, [v1, v2]);
      const rowsB = (await evidence(db)).filter((row) => row.tenant_key === TENANT_B);
      assert.deepEqual(
        rowsB.map((row) => [row.item_id, row.document_id, row.needs_check]),
        [
          ['b1', docB, false],
          ['b2', v1, false],
        ],
      );
      assert.ok((await labelledItems(db)).includes(r4));
    });

    if (multi) {
      test('a call with another tenant key changes nothing of tenant A', async () => {
        const beforeA = (await evidence(db)).filter((row) => row.tenant_key === TENANT_A);
        const deleted = await hook(db, TENANT_B, lineage, [v1, v2]);
        assert.equal(deleted, 2, "only tenant B's own twin row and r4's label");
        assert.deepEqual((await evidence(db)).filter((row) => row.tenant_key === TENANT_A), beforeA);
        assert.deepEqual(await pending(db, TENANT_A), []);
        const labels = await labelledItems(db);
        for (const item of [r1, r2, r3]) assert.ok(labels.includes(item));
      });
    }

    test('the Phase 6.3 purge of the lineage removes its evidence and labels and counts them under golden_items', async (t) => {
      const present = await db.query<{ ok: boolean }>(
        "SELECT to_regprocedure('public.rag_purge_lineage(text,uuid,jsonb,jsonb)') IS NOT NULL AS ok",
      );
      if (!present.rows[0]!.ok) {
        console.log('[Purge Hook Test] Phase 6.3 purge not on this checkout; skipped');
        t.skip('Phase 6.3 purge not on this checkout');
        return;
      }
      const r = await db.query<{ counts: unknown }>(
        'SELECT counts FROM public.rag_purge_lineage($1, $2, $3::jsonb, $4::jsonb)',
        [TENANT_A, lineage, JSON.stringify({ kind: 'admin', id: LABELLER }), JSON.stringify({ code: 'added_in_error', note: 'synthetic test purge' })],
      );
      assert.ok(findCount(r.rows[0]!.counts, 'golden_items') >= 3, JSON.stringify(r.rows[0]!.counts));
      const rows = await evidence(db);
      assert.deepEqual(rows.filter((row) => row.tenant_key === TENANT_A && (row.document_id === v1 || row.document_id === v2)), []);
      assert.ok(rows.some((row) => row.tenant_key === TENANT_B && row.document_id === v1), 'tenant B keeps its rows');
      const labels = await labelledItems(db);
      assert.ok(!labels.includes(r1));
      assert.ok(labels.includes(r4));
    });

    test('a key of the other deployment mode raises 22023', async () => {
      await assert.rejects(() => hook(db, OTHER_MODE_KEY, lineage, [v1]), (error: unknown) => codeOf(error) === '22023');
    });

    test('anon and authenticated get 42501', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () => asRole(db, role, () => hook(db, TENANT_A, lineage, [v1])),
          (error: unknown) => codeOf(error) === '42501',
          role,
        );
      }
    });

    test('clear resets the tombstone flags and register replaces the tombstones', async () => {
      await hook(db, TENANT_A, lineage, [v1, v2]);
      const cleared = await db.query<{ n: number }>('SELECT public.rag_golden_evidence_clear($1, $2, $3::text[]) AS n', [TENANT_A, SET, ['i1', 'i2']]);
      assert.equal(cleared.rows[0]!.n, 2);
      assert.deepEqual(await pending(db, TENANT_A), []);
      await register(db, TENANT_A, [{ item_id: 'i3', document_id: d2, quote_sha256: sha('fourth synthetic quote') }]);
      const rowsA = (await evidence(db)).filter((row) => row.tenant_key === TENANT_A);
      assert.deepEqual(rowsA.map((row) => [row.item_id, row.document_id]), [['i3', d2]]);
    });
  });

  describe(`rag_purge_hook_golden_items without the Phase 5.1.1 tables (${mode})`, () => {
    test('0976 applies twice and the hook counts evidence rows only', async () => {
      const files = migrationFiles(mode);
      const start = files.findIndex((file) => PHASE_FILE.test(file));
      assert.ok(start >= 0);
      const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        await applyMigrationFiles(db, files.slice(0, start));
        await db.exec('DROP TABLE IF EXISTS public.rag_retrieval_log CASCADE; DROP TABLE IF EXISTS public.rag_review_items CASCADE;');
        const phase = files.slice(start).filter((file) => PHASE_FILE.test(file) && !REQUIRES_RETRIEVAL_LOG.test(file));
        assert.ok(phase.includes(MIGRATION));
        await applyMigrationFiles(db, phase);
        await applyMigrationFiles(db, [MIGRATION]);
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_A, 'tenant-a@example.invalid']);
        const lineageId = crypto.randomUUID();
        const doc = await insertDoc(db, USER_A, lineageId);
        await register(db, TENANT_A, [{ item_id: 'i1', document_id: doc, quote_sha256: sha('only synthetic quote') }]);
        assert.equal(await hook(db, TENANT_A, lineageId, [doc]), 1);
        assert.deepEqual(await pending(db, TENANT_A), ['i1']);
      } finally {
        await db.close();
      }
    });
  });
}

for (const mode of MODES) {
  describe(`0976 and the Phase 6.3 store inventory (${mode})`, () => {
    let db: PGlite;
    let hasInventory = false;
    let hasPurge = false;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      const r = await db.query<{ inventory: boolean; purge: boolean }>(
        `SELECT to_regprocedure('public.rag_purge_store_inventory()') IS NOT NULL AS inventory,
                EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'public' AND p.proname = 'rag_purge_lineage') AS purge`,
      );
      hasInventory = r.rows[0]!.inventory;
      hasPurge = r.rows[0]!.purge;
    });

    after(async () => {
      await db?.close();
    });

    test('without the inventory, 0976 creates no Phase 6.3 object and applies twice', async (t) => {
      if (hasInventory) {
        t.skip('Phase 6.3 inventory present on this checkout');
        return;
      }
      await applyMigrationFiles(db, [MIGRATION, MIGRATION]);
      const r = await db.query<{ inventory: string | null; foreign: string | null; hooks: number }>(
        `SELECT to_regprocedure('public.rag_purge_store_inventory()')::text AS inventory,
                to_regprocedure('public.rag_purge_foreign_stores(text,uuid,uuid[])')::text AS foreign,
                (SELECT count(*)::int FROM pg_proc WHERE proname = 'rag_purge_hook_golden_items') AS hooks`,
      );
      assert.equal(r.rows[0]!.inventory, null);
      assert.equal(r.rows[0]!.foreign, null);
      assert.equal(r.rows[0]!.hooks, 1);
    });

    test('with the inventory, it lists both golden_items stores and stays service_role only', async (t) => {
      if (!hasInventory) {
        console.log('[Purge Hook Test] Phase 6.3 inventory not on this checkout; skipped');
        t.skip('Phase 6.3 inventory not on this checkout');
        return;
      }
      const rows = await db.query<{ relation: string; store_id: string; handling: string; reason: string }>(
        "SELECT relation, store_id, handling, reason FROM public.rag_purge_store_inventory() WHERE store_id = 'golden_items' ORDER BY relation",
      );
      const relations = rows.rows.map((row) => row.relation.replace(/^public\./, ''));
      assert.ok(relations.includes('rag_golden_evidence_index'));
      assert.ok(relations.includes('rag_judge_labels'));
      for (const row of rows.rows) {
        assert.equal(row.handling, 'purge_step');
        assert.ok(row.reason.length > 0);
      }
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () => asRole(db, role, () => db.query('SELECT * FROM public.rag_purge_store_inventory()')),
          (error: unknown) => codeOf(error) === '42501',
        );
      }
    });
  });
}
