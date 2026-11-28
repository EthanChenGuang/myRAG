import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

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

    const activate = (bindingId: string, actor = 'operator-test'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_activate_embedding_binding($1, $2)', [bindingId, actor]);
    const rollback = (docType: string, tenantKey: string | null, actor = 'operator-test'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_rollback_embedding_binding($1, $2, $3)', [docType, tenantKey, actor]);
    const deactivate = (docType: string, tenantKey: string | null, actor = 'operator-test'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_deactivate_embedding_binding($1, $2, $3)', [docType, tenantKey, actor]);

    async function inSavepoint(body: () => Promise<void>): Promise<void> {
      await db.exec('SAVEPOINT gate_case');
      try {
        await body();
      } finally {
        await db.exec('ROLLBACK TO SAVEPOINT gate_case');
        await db.exec('RELEASE SAVEPOINT gate_case');
      }
    }

    async function writeEvidence(bindingId: string, evidence: unknown): Promise<void> {
      await db.query('UPDATE public.embedding_profile_bindings SET eval_evidence = $2::jsonb WHERE id = $1', [bindingId, JSON.stringify(evidence)]);
    }

    interface Staged {
      binding: string;
      contractChunks: string[];
      generalChunks: string[];
      runId: string;
      evidence: Evidence;
    }

    /** A complete, proven binding of LAW for contract chunks: the chunks, their vectors, a completed run and passing evidence. */
    async function stage(options: { tenantKey: string | null; owner?: string; profileId?: string; model?: string; baselineBinding?: string | null; seedChunks?: boolean; runTenant?: string | null } = { tenantKey: tenantA }): Promise<Staged> {
      const profileId = options.profileId ?? LAW;
      const model = options.model ?? LAW_MODEL;
      const contractChunks = options.seedChunks === false ? [] : await insertDocument(CONTRACT, 3, options.owner ?? ownerA);
      const generalChunks = options.seedChunks === false ? [] : await insertDocument(GENERAL, 2, options.owner ?? ownerA);
      const inScope = (
        await db.query<{ id: string }>(
          `SELECT c.id FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
            WHERE c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = $1 AND ($2::text IS NULL OR c.tenant_key = $2)
              AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = $3)`,
          [CONTRACT, options.tenantKey, profileId],
        )
      ).rows.map((r) => r.id);
      await insertVectors(inScope, profileId, model);
      const { binding_id: binding } = await createBinding(CONTRACT, options.tenantKey, profileId);
      assert.equal(await setStatus(binding, 'backfilling'), 'accepted');
      const runId = await completedRun(profileId, options.runTenant === undefined ? options.tenantKey : options.runTenant);
      const evidence = evidenceFor(binding, profileId, CONTRACT, options.tenantKey, runId, { baseline_binding_profile: options.baselineBinding ?? null });
      assert.equal(await record(binding, evidence), 'accepted');
      return { binding, contractChunks, generalChunks, runId, evidence };
    }

    test('a complete binding with real evidence activates; out-of-scope chunks never refuse', async () => {
      await inTransaction(db, async () => {
        const staged = await stage({ tenantKey: tenantA });
        assert.ok(staged.generalChunks.length > 0);
        const result = await db.query<{ activated_binding: string; previous_binding: string | null }>('SELECT * FROM public.rag_activate_embedding_binding($1, $2)', [
          staged.binding,
          'operator-test',
        ]);
        assert.deepEqual(result.rows[0], { activated_binding: staged.binding, previous_binding: null });
        const row = await bindingRow(staged.binding);
        assert.equal(row.status, 'active');
        assert.equal(row.activated_by, 'operator-test');
        assert.equal(row.previous_binding_id, null);
        assert.match(await activate(staged.binding), /^binding_refused: already_active/);
        assert.equal((await db.query<{ id: string }>("SELECT id FROM public.embedding_profiles WHERE status = 'active'")).rows[0]!.id, globalProfile);
      });
    });

    test('a deployment-wide binding activates only with a deployment-wide run', async () => {
      await inTransaction(db, async () => {
        const tenantRun = await stage({ tenantKey: null, runTenant: tenantA });
        assert.match(await activate(tenantRun.binding), /^binding_refused: eval_run_mismatch/);
        const wideRun = await completedRun(LAW, null);
        await writeEvidence(tenantRun.binding, { ...tenantRun.evidence, backfill_run_id: wideRun });
        assert.equal(await activate(tenantRun.binding), 'accepted');
        assert.equal((await bindingRow(tenantRun.binding)).status, 'active');
      });
    });

    test('every gate refusal has its own code', async () => {
      await inTransaction(db, async () => {
        const staged = await stage({ tenantKey: tenantA });
        const { binding, contractChunks, evidence } = staged;
        const cases: Array<[string, RegExp, () => Promise<void>]> = [
          ['actor', /^binding_refused: actor_required/, async () => {}],
          ['incomplete', /^binding_refused: incomplete/, async () => {
            await db.query('DELETE FROM public.chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [contractChunks[0], LAW]);
          }],
          ['model_mismatch', /^binding_refused: model_mismatch/, async () => {
            await db.query("UPDATE public.chunk_embeddings SET embedding_model = 'voyage-4-large' WHERE chunk_id = $1 AND profile_id = $2", [contractChunks[1], LAW]);
          }],
          ['eval_missing', /^binding_refused: eval_missing/, async () => {
            await db.query('UPDATE public.embedding_profile_bindings SET eval_evidence = NULL WHERE id = $1', [binding]);
          }],
          ['evidence_mismatch', /^binding_refused: evidence_mismatch/, async () => writeEvidence(binding, { ...evidence, binding_id: crypto.randomUUID() })],
          ['eval_baseline_mismatch', /^binding_refused: eval_baseline_mismatch/, async () => {
            await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active'");
            await db.query("UPDATE public.embedding_profiles SET status = 'active' WHERE id = $1", [UNSCOPED]);
          }],
          ['eval_binding_baseline_mismatch', /^binding_refused: eval_binding_baseline_mismatch/, async () => writeEvidence(binding, { ...evidence, baseline_binding_profile: DOMAIN })],
          ['eval_failed (gate)', /^binding_refused: eval_failed/, async () => writeEvidence(binding, { ...evidence, gate_passed: false })],
          ['eval_failed (slice)', /^binding_refused: eval_failed/, async () => writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, passed: false } })],
          ['eval_insufficient_real_items (29)', /^binding_refused: eval_insufficient_real_items/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, real_n: 29 } })],
          ['eval_insufficient_real_items (fixture-like 3 of 40)', /^binding_refused: eval_insufficient_real_items/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, real_n: 3 } })],
          ['eval_insufficient_real_items (not a number)', /^binding_refused: eval_insufficient_real_items/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, real_n: '30' } })],
          ['eval_insufficient_real_items (real above total)', /^binding_refused: eval_insufficient_real_items/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, n: 20, real_n: 30 } })],
          ['eval_language_regression', /^binding_refused: eval_language_regression/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, by_language: { zh: true, en: true, it: false } } })],
          ['eval_language_regression (no sub-slice)', /^binding_refused: eval_language_regression/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, by_language: {} } })],
          ['eval_language_regression (non-boolean)', /^binding_refused: eval_language_regression/, async () =>
            writeEvidence(binding, { ...evidence, doc_type_slice: { ...evidence.doc_type_slice, by_language: { xx: 'true' } } })],
          ['eval_other_slices', /^binding_refused: eval_other_slices/, async () => writeEvidence(binding, { ...evidence, other_slices_passed: false })],
          ['eval_run_mismatch (running)', /^binding_refused: eval_run_mismatch/, async () => {
            await db.query("UPDATE public.embedding_backfill_runs SET status = 'running' WHERE id = $1", [staged.runId]);
          }],
          ['eval_run_mismatch (other profile)', /^binding_refused: eval_run_mismatch/, async () =>
            writeEvidence(binding, { ...evidence, backfill_run_id: await completedRun(DOMAIN, tenantA) })],
          ['eval_run_mismatch (unknown run)', /^binding_refused: eval_run_mismatch/, async () => writeEvidence(binding, { ...evidence, backfill_run_id: crypto.randomUUID() })],
          ['eval_stale', /^binding_refused: eval_stale/, async () => {
            await db.query("UPDATE public.chunk_embeddings SET embedded_at = now() + interval '1 hour' WHERE chunk_id = $1 AND profile_id = $2", [contractChunks[2], LAW]);
          }],
          ['eval_stale (unparseable)', /^binding_refused: eval_stale/, async () => writeEvidence(binding, { ...evidence, recorded_at: 'not a time' })],
          ['binding_retired', /^binding_refused: binding_retired/, async () => {
            assert.equal(await setStatus(binding, 'retired'), 'accepted');
          }],
        ];
        for (const [name, pattern, mutate] of cases) {
          await inSavepoint(async () => {
            await mutate();
            const result = name === 'actor' ? await activate(binding, ' ') : await activate(binding);
            assert.match(result, pattern, `${name}: ${result}`);
            assert.notEqual((await bindingRow(binding)).status, 'active', name);
          });
        }
        assert.match(await activate(crypto.randomUUID()), /^binding_refused: unknown_binding/);

        assert.equal(await activate(binding), 'accepted', 'the staged binding activates once every mutation is undone');
      });
    });

    test('a tenant binding accepts a deployment-wide run of its profile', async () => {
      await inTransaction(db, async () => {
        const staged = await stage({ tenantKey: tenantA, runTenant: null });
        assert.equal(await activate(staged.binding), 'accepted');
      });
    });

    test('a second binding for the same key replaces the first, rollback restores it, deactivate leaves global only', async () => {
      await inTransaction(db, async () => {
        const law = await stage({ tenantKey: tenantA });
        assert.equal(await activate(law.binding), 'accepted');

        assert.match(await rollback(CONTRACT, tenantA), /^binding_refused: no_previous/);

        const domain = await stage({ tenantKey: tenantA, profileId: DOMAIN, model: DOMAIN_MODEL, seedChunks: false });
        assert.match(await activate(domain.binding), /^binding_refused: eval_binding_baseline_mismatch/, 'evidence proven against no binding is stale once law-2 is active');
        await writeEvidence(domain.binding, { ...domain.evidence, baseline_binding_profile: LAW });
        const result = await db.query<{ activated_binding: string; previous_binding: string | null }>('SELECT * FROM public.rag_activate_embedding_binding($1, $2)', [
          domain.binding,
          'operator-test',
        ]);
        assert.deepEqual(result.rows[0], { activated_binding: domain.binding, previous_binding: law.binding });
        assert.equal((await bindingRow(law.binding)).status, 'available');
        assert.equal((await bindingRow(domain.binding)).status, 'active');
        assert.equal((await bindingRow(domain.binding)).previous_binding_id, law.binding);
        const active = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.embedding_profile_bindings WHERE status = 'active' AND doc_type = $1 AND COALESCE(tenant_key, '') = $2", [
          CONTRACT,
          tenantA,
        ]);
        assert.equal(active.rows[0]!.n, 1);

        await inSavepoint(async () => {
          await db.query('DELETE FROM public.chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [law.contractChunks[0], LAW]);
          assert.match(await rollback(CONTRACT, tenantA), /^binding_refused: previous_incomplete/);
          assert.equal((await bindingRow(domain.binding)).status, 'active');
        });
        await inSavepoint(async () => {
          await db.query("UPDATE public.chunk_embeddings SET embedding_model = 'voyage-4-large' WHERE chunk_id = $1 AND profile_id = $2", [law.contractChunks[0], LAW]);
          assert.match(await rollback(CONTRACT, tenantA), /^binding_refused: previous_incomplete/);
        });
        assert.match(await rollback(CONTRACT, tenantA, ''), /^binding_refused: actor_required/);

        const vectorsBefore = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.chunk_embeddings')).rows[0]!.n;
        const restored = await db.query<{ restored_binding: string; rolled_back_binding: string }>('SELECT * FROM public.rag_rollback_embedding_binding($1, $2, $3)', [
          CONTRACT,
          tenantA,
          'operator-test',
        ]);
        assert.deepEqual(restored.rows[0], { restored_binding: law.binding, rolled_back_binding: domain.binding });
        assert.equal((await bindingRow(law.binding)).status, 'active');
        assert.equal((await bindingRow(domain.binding)).status, 'available');
        assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.chunk_embeddings')).rows[0]!.n, vectorsBefore, 'rollback deletes no vector');

        assert.match(await deactivate(CONTRACT, tenantA, ''), /^binding_refused: actor_required/);
        const off = await db.query<{ deactivated_binding: string }>('SELECT * FROM public.rag_deactivate_embedding_binding($1, $2, $3)', [CONTRACT, tenantA, 'operator-test']);
        assert.deepEqual(off.rows[0], { deactivated_binding: law.binding });
        const remaining = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.embedding_profile_bindings WHERE status = 'active'");
        assert.equal(remaining.rows[0]!.n, 0);
        assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.chunk_embeddings')).rows[0]!.n, vectorsBefore, 'deactivate deletes no vector');
        assert.match(await deactivate(CONTRACT, tenantA), /^binding_refused: no_active/);
        assert.match(await rollback(CONTRACT, tenantA), /^binding_refused: no_active/);
        assert.match(await deactivate(CONTRACT, null), /^binding_refused: no_active/);
      });
    });

    test('activate and rollback lock the bindings table, cap their run time and keep the real-items threshold in one constant', async () => {
      const rows = (
        await db.query<{ name: string; source: string; config: string[] | null }>(
          `SELECT p.proname AS name, p.prosrc AS source, p.proconfig AS config FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1::text[])`,
          [['rag_create_embedding_binding', 'rag_set_embedding_binding_status', 'rag_record_binding_evidence', 'rag_activate_embedding_binding', 'rag_rollback_embedding_binding', 'rag_deactivate_embedding_binding']],
        )
      ).rows;
      assert.equal(rows.length, 6);
      for (const row of rows) {
        assert.match(row.source, /LOCK TABLE public\.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE/, `${row.name} takes no table lock`);
        if (row.name === 'rag_activate_embedding_binding' || row.name === 'rag_rollback_embedding_binding') {
          assert.ok(row.config?.includes('statement_timeout=120s'), `${row.name} has no statement_timeout`);
        }
      }
      const gate = rows.find((r) => r.name === 'rag_activate_embedding_binding')!.source;
      assert.match(gate, /c_min_real_items\s+CONSTANT\s+integer\s*:=\s*30/);
      assert.doesNotMatch(gate, /'(zh|en|it)'/, 'the gate names no language code');
    });

    test('applying 0441 a second time keeps every function, body and grant', async () => {
      const read = async (): Promise<string> =>
        JSON.stringify(
          (
            await db.query(
              `SELECT p.oid::regprocedure::text AS sig, pg_catalog.pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = ANY ($1::text[]) ORDER BY 1`,
              [SIGNATURES],
            )
          ).rows,
        );
      const before = await read();
      assert.equal((JSON.parse(before) as unknown[]).length, SIGNATURES.length);
      await applyMigrationFiles(db, [MIGRATION]);
      assert.equal(await read(), before);
    });

    if (mode === 'multi-tenant') {
      test('two tenants: a tenant binding counts only its own chunks and never changes another tenant or the deployment-wide row', async () => {
        await inTransaction(db, async () => {
          const tenantB = `u:${SECOND_USER}`;
          const bChunks = await insertDocument(CONTRACT, 2, SECOND_USER);
          const { binding_id: bBinding } = await createBinding(CONTRACT, tenantB, LAW);
          assert.equal(await setStatus(bBinding, 'backfilling'), 'accepted');

          const a = await stage({ tenantKey: tenantA });
          const { binding_id: wide } = await createBinding(CONTRACT, null, LAW);

          await insertVectors([bChunks[0]!], LAW, 'voyage-4-large', "now() + interval '1 hour'");
          assert.equal(await activate(a.binding), 'accepted', 'o:B missing and mismatched vectors never refuse A');
          assert.equal((await bindingRow(a.binding)).status, 'active');
          assert.equal((await bindingRow(bBinding)).status, 'backfilling');
          assert.equal((await bindingRow(wide)).status, 'available');

          const wideRun = await completedRun(LAW, null);
          assert.equal(await record(wide, evidenceFor(wide, LAW, CONTRACT, null, wideRun)), 'accepted');
          assert.match(await activate(wide), /^binding_refused: incomplete/, 'a deployment-wide binding counts every tenant');

          const bRun = await completedRun(LAW, tenantB);
          const bEvidence = evidenceFor(bBinding, LAW, CONTRACT, tenantB, bRun);
          assert.equal(await record(bBinding, bEvidence), 'accepted');
          assert.match(await activate(bBinding), /^binding_refused: incomplete/);
          await insertVectors([bChunks[1]!], LAW, LAW_MODEL);
          assert.match(await activate(bBinding), /^binding_refused: model_mismatch/);
          await db.query('UPDATE public.chunk_embeddings SET embedding_model = $3 WHERE chunk_id = $1 AND profile_id = $2', [bChunks[0], LAW, LAW_MODEL]);
          assert.match(await activate(bBinding), /^binding_refused: eval_stale/, "B's own newer vector makes B's evidence stale");
          await writeEvidence(bBinding, { ...bEvidence, backfill_run_id: a.runId });
          await db.query("UPDATE public.chunk_embeddings SET embedded_at = now() - interval '2 hours' WHERE chunk_id = $1 AND profile_id = $2", [bChunks[0], LAW]);
          assert.match(await activate(bBinding), /^binding_refused: eval_run_mismatch/, "A's run does not cover B");
          await writeEvidence(bBinding, bEvidence);
          assert.equal(await activate(bBinding), 'accepted');
          assert.equal((await bindingRow(a.binding)).status, 'active', "B's activation leaves A's binding active");
          assert.equal((await bindingRow(bBinding)).previous_binding_id, null);

          assert.equal(await deactivate(CONTRACT, tenantA), 'accepted');
          assert.equal((await bindingRow(bBinding)).status, 'active', "deactivating A leaves B's binding active");
          assert.notEqual(await rollback(CONTRACT, 's:default'), 'accepted');
        });
      });
    }
  });
}
