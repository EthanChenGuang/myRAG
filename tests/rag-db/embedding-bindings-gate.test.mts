import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0441_binding_gate.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const LAW = 'voyage-law-2-1024';
const LAW_MODEL = 'voyage-law-2';
const DOMAIN = 'voyage-4-large-1024-domain';
const DOMAIN_MODEL = 'voyage-4-large';
const FINANCE = 'voyage-finance-2-1024';
const UNSCOPED = 'voyage-4-large-1024';
const CONTRACT = 'contract_legal';
const GENERAL = 'general';
const SECOND_USER = '00000000-0000-4000-8000-0000000000b7';

const SIGNATURES = [
  'rag_list_embedding_bindings()',
  'rag_list_embedding_profile_scopes()',
  'rag_create_embedding_binding(text,text,text,text)',
  'rag_set_embedding_binding_status(uuid,text,text)',
  'rag_record_binding_evidence(uuid,jsonb,text)',
  'rag_activate_embedding_binding(uuid,text)',
  'rag_rollback_embedding_binding(text,text,text)',
  'rag_deactivate_embedding_binding(text,text,text)',
];
const TASK1_SIGNATURES = SIGNATURES.slice(0, 5);

type Role = 'anon' | 'authenticated' | 'service_role';

interface Evidence {
  binding_id: string;
  target_profile: string;
  doc_type: string;
  tenant_key: string | null;
  baseline_global_profile: string;
  baseline_binding_profile: string | null;
  gate_passed: boolean;
  doc_type_slice: { n: number; real_n: number; passed: boolean; by_language: Record<string, boolean> };
  other_slices_passed: boolean;
  backfill_run_id: string;
  recorded_at: string;
}

function vectorLiteral(dims: number): string {
  return `[${Array.from({ length: dims }, () => 0.1).join(',')}]`;
}

async function inTransaction(db: PGlite, body: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await body();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** 'accepted' or the error message; the surrounding transaction survives a refusal. */
async function outcome(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  await db.exec('SAVEPOINT attempt');
  try {
    await db.query(sql, params);
    await db.exec('RELEASE SAVEPOINT attempt');
    return 'accepted';
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return error instanceof Error ? error.message : String(error);
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

for (const mode of MODES) {
  describe(`0441 binding gate (${mode})`, () => {
    let db: PGlite;
    let ownerA: string;
    let tenantA: string;
    let globalProfile: string;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      ownerA = fixture.fixtureUserId;
      tenantA = mode === 'multi-tenant' ? `u:${ownerA}` : 's:default';
      if (mode === 'multi-tenant') {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SECOND_USER, 'second-user@example.invalid']);
      }
      globalProfile = (await db.query<{ id: string }>("SELECT id FROM public.embedding_profiles WHERE status = 'active'")).rows[0]!.id;
    });

    after(async () => {
      await db?.close();
    });

    async function insertDocument(docType: string, chunks: number, owner: string = ownerA): Promise<string[]> {
      const documentId = crypto.randomUUID();
      const ids: string[] = [];
      if (mode === 'multi-tenant') {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
          documentId,
          `gate-${documentId.slice(0, 8)}.md`,
          'A neutral synthetic paragraph about a sample record.',
          '{}',
          owner,
          docType,
        ]);
      } else {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          documentId,
          `gate-${documentId.slice(0, 8)}.md`,
          'A neutral synthetic paragraph about a sample record.',
          '{}',
          docType,
        ]);
      }
      for (let index = 0; index < chunks; index += 1) {
        const chunkId = crypto.randomUUID();
        await db.query('INSERT INTO public.document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
          chunkId,
          documentId,
          `A neutral synthetic sentence number ${index}.`,
          index,
          '{}',
        ]);
        ids.push(chunkId);
      }
      return ids;
    }

    async function insertVectors(chunkIds: string[], profileId: string, model: string, embeddedAt = "now() - interval '2 hours'"): Promise<void> {
      for (const chunkId of chunkIds) {
        await db.query(
          `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
           SELECT c.id, $2, c.tenant_key, $3::public.halfvec, $4, 1024, ${embeddedAt} FROM public.document_chunks c WHERE c.id = $1`,
          [chunkId, profileId, vectorLiteral(1024), model],
        );
      }
    }

    async function createBinding(docType: string, tenantKey: string | null, profileId: string, actor = 'operator-test'): Promise<{ binding_id: string; binding_status: string; created: boolean }> {
      const result = await db.query<{ binding_id: string; binding_status: string; created: boolean }>(
        'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)',
        [docType, tenantKey, profileId, actor],
      );
      return result.rows[0]!;
    }

    async function bindingRow(id: string): Promise<{ status: string; previous_binding_id: string | null; eval_evidence: Evidence | null; activated_by: string | null }> {
      return (await db.query<{ status: string; previous_binding_id: string | null; eval_evidence: Evidence | null; activated_by: string | null }>(
        'SELECT status, previous_binding_id, eval_evidence, activated_by FROM public.embedding_profile_bindings WHERE id = $1',
        [id],
      )).rows[0]!;
    }

    async function completedRun(profileId: string, tenantKey: string | null, status = 'completed'): Promise<string> {
      const result = await db.query<{ id: string }>('INSERT INTO public.embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, $3) RETURNING id', [
        profileId,
        tenantKey,
        status,
      ]);
      return result.rows[0]!.id;
    }

    function evidenceFor(bindingId: string, profileId: string, docType: string, tenantKey: string | null, runId: string, overrides: Partial<Evidence> = {}): Evidence {
      return {
        binding_id: bindingId,
        target_profile: profileId,
        doc_type: docType,
        tenant_key: tenantKey,
        baseline_global_profile: globalProfile,
        baseline_binding_profile: null,
        gate_passed: true,
        doc_type_slice: { n: 40, real_n: 30, passed: true, by_language: { zh: true, en: true, it: true } },
        other_slices_passed: true,
        backfill_run_id: runId,
        recorded_at: new Date().toISOString(),
        ...overrides,
      };
    }

    const record = (bindingId: string, evidence: unknown, actor = 'operator-test'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_record_binding_evidence($1, $2::jsonb, $3)', [bindingId, JSON.stringify(evidence), actor]);
    const setStatus = (bindingId: string, status: string, actor = 'operator-test'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [bindingId, status, actor]);

    test('0441 exists and defines every binding function', async () => {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION)), `${MIGRATION} missing`);
      for (const signature of TASK1_SIGNATURES) {
        const found = await db.query<{ found: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS found', [signature]);
        assert.equal(found.rows[0]?.found, true, `${signature} missing`);
      }
    });

    test('create returns the same row for the same triple and refuses an unscoped profile and an empty actor', async () => {
      await inTransaction(db, async () => {
        const first = await createBinding(CONTRACT, tenantA, LAW);
        assert.equal(first.binding_status, 'available');
        assert.equal(first.created, true);
        const second = await createBinding(CONTRACT, tenantA, LAW);
        assert.equal(second.binding_id, first.binding_id);
        assert.equal(second.created, false);
        const wide = await createBinding(CONTRACT, null, LAW);
        assert.notEqual(wide.binding_id, first.binding_id);
        assert.equal((await createBinding(CONTRACT, null, LAW)).binding_id, wide.binding_id);

        assert.match(await outcome(db, 'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [CONTRACT, tenantA, UNSCOPED, 'operator-test']), /^binding_refused: profile_scope_mismatch/);
        assert.match(await outcome(db, 'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [GENERAL, tenantA, LAW, 'operator-test']), /^binding_refused: profile_scope_mismatch/);
        assert.match(await outcome(db, 'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [CONTRACT, tenantA, LAW, '']), /^binding_refused: actor_required/);
        assert.match(await outcome(db, 'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [CONTRACT, tenantA, LAW, '  ']), /^binding_refused: actor_required/);
        const otherMode = mode === 'multi-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;
        assert.notEqual(await outcome(db, 'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [CONTRACT, otherMode, LAW, 'operator-test']), 'accepted');
      });
    });

    test('set status moves between available, backfilling and retired; active and active rows are refused; one backfilling row per key', async () => {
      await inTransaction(db, async () => {
        const { binding_id: law } = await createBinding(CONTRACT, tenantA, LAW);
        const { binding_id: domain } = await createBinding(CONTRACT, tenantA, DOMAIN);
        assert.equal(await setStatus(law, 'backfilling'), 'accepted');
        assert.equal((await bindingRow(law)).status, 'backfilling');
        assert.match(await setStatus(domain, 'backfilling'), /^binding_refused: backfilling_exists/);
        assert.equal(await setStatus(law, 'retired'), 'accepted');
        assert.equal(await setStatus(domain, 'backfilling'), 'accepted');
        assert.equal(await setStatus(law, 'available'), 'accepted');
        assert.equal((await bindingRow(law)).status, 'available');

        assert.match(await setStatus(law, 'active'), /^binding_refused: use_activation_gate/);
        assert.match(await setStatus(law, 'bogus'), /^binding_refused: invalid_status/);
        assert.match(await setStatus(law, 'retired', ''), /^binding_refused: actor_required/);
        assert.match(await setStatus(crypto.randomUUID(), 'retired'), /^binding_refused: unknown_binding/);

        await db.query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [law]);
        for (const status of ['available', 'backfilling', 'retired']) {
          assert.match(await setStatus(law, status), /^binding_refused: binding_is_active/);
        }
        assert.equal((await bindingRow(law)).status, 'active');
      });
    });

    test('evidence must name this binding, its profile, doc type and tenant; an active binding takes none; valid evidence shows in the list', async () => {
      await inTransaction(db, async () => {
        const { binding_id: law } = await createBinding(CONTRACT, tenantA, LAW);
        const { binding_id: wide } = await createBinding(CONTRACT, null, LAW);
        const runId = crypto.randomUUID();
        const good = evidenceFor(law, LAW, CONTRACT, tenantA, runId);

        assert.match(await record(law, { ...good, binding_id: wide }), /^binding_refused: evidence_mismatch/);
        assert.match(await record(law, { ...good, tenant_key: null }), /^binding_refused: evidence_mismatch/);
        assert.match(await record(wide, { ...good, binding_id: wide }), /^binding_refused: evidence_mismatch/);
        assert.match(await record(law, { ...good, target_profile: DOMAIN }), /^binding_refused: evidence_mismatch/);
        assert.match(await record(law, { ...good, doc_type: GENERAL }), /^binding_refused: evidence_mismatch/);
        assert.match(await record(law, [good]), /^binding_refused: invalid_evidence/);
        assert.match(await record(law, good, ''), /^binding_refused: actor_required/);
        assert.match(await record(crypto.randomUUID(), good), /^binding_refused: unknown_binding/);
        assert.equal((await bindingRow(law)).eval_evidence, null);

        assert.equal(await record(law, good), 'accepted');
        assert.equal(await record(wide, evidenceFor(wide, LAW, CONTRACT, null, runId)), 'accepted');
        assert.deepEqual((await bindingRow(law)).eval_evidence, good);

        const list = (
          await db.query<{ id: string; doc_type: string; tenant_key: string | null; profile_id: string; model: string; doc_types: string[]; status: string; previous_binding_id: string | null; has_evidence: boolean; baseline_global_profile: string | null }>(
            'SELECT * FROM public.rag_list_embedding_bindings()',
          )
        ).rows;
        const row = list.find((r) => r.id === law);
        assert.ok(row);
        assert.equal(row.doc_type, CONTRACT);
        assert.equal(row.tenant_key, tenantA);
        assert.equal(row.profile_id, LAW);
        assert.equal(row.model, LAW_MODEL);
        assert.deepEqual(row.doc_types, [CONTRACT]);
        assert.equal(row.status, 'available');
        assert.equal(row.previous_binding_id, null);
        assert.equal(row.has_evidence, true);
        assert.equal(row.baseline_global_profile, globalProfile);

        await db.query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [law]);
        assert.match(await record(law, good), /^binding_refused: binding_is_active/);
      });
    });

    test('profile scopes list every profile with its doc types', async () => {
      const rows = (await db.query<{ id: string; doc_types: string[] | null }>('SELECT * FROM public.rag_list_embedding_profile_scopes()')).rows;
      const byId = new Map(rows.map((r) => [r.id, r.doc_types]));
      assert.equal(byId.get(UNSCOPED), null);
      assert.equal(byId.get(globalProfile), null);
      assert.deepEqual(byId.get(LAW), [CONTRACT]);
      assert.deepEqual([...(byId.get(FINANCE) ?? [])].sort(), ['financial_report', 'invoice_receipt']);
      const total = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.embedding_profiles')).rows[0]!.n;
      assert.equal(rows.length, total);
    });

    test('only service_role can execute the binding functions; every one has an empty search_path', async () => {
      for (const signature of SIGNATURES) {
        const acl = (
          await db.query<{ found: boolean; anon: boolean; authenticated: boolean; service_role: boolean; public_exec: boolean; empty_path: boolean }>(
            `SELECT to_regprocedure($1) IS NOT NULL AS found,
                    COALESCE(has_function_privilege('anon', to_regprocedure($1), 'EXECUTE'), false) AS anon,
                    COALESCE(has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE'), false) AS authenticated,
                    COALESCE(has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE'), false) AS service_role,
                    EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                             WHERE p.oid = to_regprocedure($1) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
                    COALESCE((SELECT 'search_path=""' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = to_regprocedure($1)), false) AS empty_path`,
            [signature],
          )
        ).rows[0]!;
        if (!acl.found && !TASK1_SIGNATURES.includes(signature)) continue;
        assert.equal(acl.found, true, `${signature} missing`);
        assert.equal(acl.anon, false, `${signature} executable by anon`);
        assert.equal(acl.authenticated, false, `${signature} executable by authenticated`);
        assert.equal(acl.public_exec, false, `${signature} executable by PUBLIC`);
        assert.equal(acl.service_role, true, `${signature} not executable by service_role`);
        assert.equal(acl.empty_path, true, `${signature} must SET search_path = ''`);
      }
      for (const role of ['anon', 'authenticated'] as Role[]) {
        const refused = await asRole(db, role, async () => {
          try {
            await db.query('SELECT * FROM public.rag_list_embedding_bindings()');
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });
        assert.match(refused ?? '', /permission denied/, `${role} could call rag_list_embedding_bindings`);
      }
      const asService = await asRole(db, 'service_role', async () => (await db.query('SELECT * FROM public.rag_list_embedding_profile_scopes()')).rows.length);
      assert.ok(asService > 0);
    });
  });
}
