import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { allowListEntryFor } from '../helpers/security-definer-allow-list';

// 06.1-20: fine-tune slots served through 3.1.1 bindings (D-28, D-29, D-33, D-35). Synthetic tenants and neutral sentences only.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0654_finetune_binding_guard.sql');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

const SLOT_A = 'ft-a-1024';
const SLOT_B = 'ft-b-1024';
const LEGACY = 'openai-3-small-1536';
const CONTRACT = 'contract_legal';
const GENERAL = 'general';
const SECOND_USER = '22222222-2222-4222-8222-222222222222';
const THIRD_USER = '33333333-3333-4333-8333-333333333333';
const OP_GUC = 'myrag.ft_slot_op';

const FUNCTIONS = [
  'public.rag_finetune_bind_scoped_slot(text, text, text[], text)',
  'public.rag_finetune_scope_slot(text, text[], text)',
  'public.rag_finetune_normalize_doc_types(text[], text)',
  'public.rag_finetune_clear_slot(text, text, integer)',
  'public.rag_finetune_binding_guard()',
  'public.rag_finetune_backfill_run_guard()',
  'public.rag_finetune_slot_guard()',
  'public.rag_finetune_version_taint_guard()',
];

function unitVector(axis: number): number[] {
  return Array.from({ length: 1024 }, (_, index) => (index === axis ? 1 : 0));
}

function vectorLiteral(seed = 1): string {
  return `[${Array.from({ length: 1024 }, (_, index) => ((index + seed) % 7) / 10 + 0.05).join(',')}]`;
}

function card(id: string, scope: 'deployment' | 'tenant', tenantKeys: string[]): Record<string, unknown> {
  return {
    id,
    base_model: 'example/base-embedding-model',
    base_revision: 'a'.repeat(40),
    dims: 1024,
    scope,
    tenant_keys: [...tenantKeys].sort(),
    dataset_manifest_sha256: 'b'.repeat(64),
    training_config_sha256: 'c'.repeat(64),
    query_prompt: `query prompt of ${id}: `,
    document_prompt: 'passage: ',
    offline: { passed: true, noise_band: 0.01, reasons: [], models: { finetuned: { overall: { n: 12, recall_at_10: 0.8, mrr_at_10: 0.6, ndcg_at_10: 0.65 } } } },
    status: 'candidate',
    probe: {
      texts: ['first neutral probe sentence', 'second neutral probe sentence', 'third neutral probe sentence'],
      query_prompt: `query prompt of ${id}: `,
      document_prompt: 'passage: ',
      vectors: [unitVector(0), unitVector(1), unitVector(2)],
    },
    artifact_uri: `s3://models-bucket/${id}`,
  };
}

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

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';

  describe(`0654 fine-tune binding guard (${mode})`, () => {
    let db: PGlite;
    let ownerA: string;
    let tenantA: string;
    let tenantB: string;
    let tenantC: string;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      ownerA = fixture.fixtureUserId;
      tenantA = multi ? `u:${ownerA}` : 's:default';
      tenantB = `u:${SECOND_USER}`;
      tenantC = `u:${THIRD_USER}`;
      if (multi) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [SECOND_USER, 'second-user@example.invalid', THIRD_USER, 'third-user@example.invalid']);
      }
    });

    after(async () => {
      await db?.close();
    });

    async function inTransaction(body: () => Promise<void>): Promise<void> {
      await db.exec('BEGIN');
      try {
        await body();
      } finally {
        await db.exec('ROLLBACK');
      }
    }

    async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
      const result = await db.query<{ v: T }>(sql, params);
      return result.rows[0]?.v as T;
    }

    async function grant(tenant: string, scope: 'private' | 'deployment'): Promise<void> {
      await db.query('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenant, scope, 'TICKET-1', 'op']);
    }

    async function register(id: string, scope: 'deployment' | 'tenant', tenants: string[]): Promise<void> {
      for (const tenant of tenants) await grant(tenant, scope === 'tenant' ? 'private' : 'deployment');
      await db.query('SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', [JSON.stringify(card(id, scope, tenants)), 'op']);
    }

    const bindScoped = (slot: string, version: string, docTypes: string[] | null, actor: string | null = 'op'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_finetune_bind_scoped_slot($1, $2, $3::text[], $4)', [slot, version, docTypes, actor]);

    const scopeSlot = (slot: string, docTypes: string[] | null, actor: string | null = 'op'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_finetune_scope_slot($1, $2::text[], $3)', [slot, docTypes, actor]);

    const createBinding = (docType: string, tenant: string | null, profile: string = SLOT_A): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [docType, tenant, profile, 'op']);

    async function bindingId(docType: string, tenant: string | null, profile: string = SLOT_A): Promise<string> {
      const rows = await db.query<{ binding_id: string }>('SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, $4)', [docType, tenant, profile, 'op']);
      const id = rows.rows[0]?.binding_id;
      assert.ok(id, 'binding created');
      return id;
    }

    async function slotRow(id: string): Promise<{ model: string; status: string; doc_types: string[] | null; eval_evidence: unknown }> {
      const result = await db.query<{ model: string; status: string; doc_types: string[] | null; eval_evidence: unknown }>(
        'SELECT model, status, doc_types, eval_evidence FROM public.embedding_profiles WHERE id = $1',
        [id],
      );
      assert.ok(result.rows[0]);
      return result.rows[0];
    }

    /** One document of the doc type with `chunks` chunks; multi-tenant documents belong to `owner`. Returns the chunk ids. */
    async function insertDocument(docType: string, chunks: number, owner: string = ownerA): Promise<string[]> {
      const documentId = crypto.randomUUID();
      const name = `binding-${documentId.slice(0, 8)}.md`;
      if (multi) {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
          documentId,
          name,
          'A neutral synthetic paragraph about a sample record.',
          '{}',
          owner,
          docType,
        ]);
      } else {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          documentId,
          name,
          'A neutral synthetic paragraph about a sample record.',
          '{}',
          docType,
        ]);
      }
      const ids: string[] = [];
      for (let index = 0; index < chunks; index += 1) {
        const chunkId = crypto.randomUUID();
        await db.query(
          'INSERT INTO public.document_chunks (id, document_id, content, chunk_index, metadata, embedding) VALUES ($1, $2, $3, $4, $5::jsonb, array_fill(0.01::float4, ARRAY[1536])::public.vector)',
          [chunkId, documentId, `A neutral synthetic sentence number ${index}.`, index, '{}'],
        );
        ids.push(chunkId);
      }
      return ids;
    }

    /** What write_batch would store for the run's chunks: vectors of the slot's model for the tenant's in-scope chunks. */
    async function writeSlotVectors(profileId: string, model: string, tenant: string): Promise<number> {
      const result = await db.query(
        `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
         SELECT c.id, $1, c.tenant_key, $2::public.halfvec, $3, 1024, now() - interval '2 hours'
         FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
         JOIN public.embedding_profiles p ON p.id = $1
         WHERE c.is_current AND c.status = 'ready' AND c.tenant_key = $4 AND COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types)
         ON CONFLICT DO NOTHING`,
        [profileId, vectorLiteral(), model, tenant],
      );
      return result.affectedRows ?? 0;
    }

    const slotVectors = (tenant: string): Promise<number> =>
      value<number>('SELECT count(*)::int AS v FROM public.chunk_embeddings WHERE profile_id = $1 AND tenant_key = $2', [SLOT_A, tenant]);

    function bindingEvidence(id: string, tenant: string | null, runId: string): Record<string, unknown> {
      return {
        binding_id: id,
        target_profile: SLOT_A,
        doc_type: CONTRACT,
        tenant_key: tenant,
        baseline_global_profile: LEGACY,
        baseline_binding_profile: null,
        gate_passed: true,
        doc_type_slice: { n: 40, real_n: 40, passed: true, by_language: { en: true } },
        other_slices_passed: true,
        backfill_run_id: runId,
        recorded_at: new Date().toISOString(),
      };
    }

    /** Version, scoped bind, tenant binding, backfill run, vectors, evidence, gate: the 3.1.1 route for a private model of tenant A. */
    async function privateBindingActive(version = 'ft-private-a-v1'): Promise<string> {
      await register(version, 'tenant', [tenantA]);
      assert.equal(await bindScoped(SLOT_A, version, [CONTRACT]), 'accepted');
      const id = await bindingId(CONTRACT, tenantA);
      await db.query('SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [id, 'backfilling', 'op']);
      const run = await db.query<{ run_id: string }>('SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, tenantA, 'op']);
      const runId = run.rows[0]?.run_id as string;
      await writeSlotVectors(SLOT_A, version, tenantA);
      await db.query('SELECT * FROM public.rag_reembed_finish_run($1, $2)', [runId, 'completed']);
      await db.query('SELECT * FROM public.rag_record_binding_evidence($1, $2::jsonb, $3)', [id, JSON.stringify(bindingEvidence(id, tenantA, runId)), 'op']);
      assert.equal(await outcome(db, 'SELECT * FROM public.rag_activate_embedding_binding($1, $2)', [id, 'op']), 'accepted');
      return id;
    }

    describe('scoped bind and scope (Task 1)', () => {
      test('bind_scoped_slot binds a tenant-scope version and sets doc_types in one call; NULL or empty doc types are refused', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.match(await bindScoped(SLOT_A, 'ft-private-a-v1', null), /bind_refused: doc_types_empty/);
          assert.match(await bindScoped(SLOT_A, 'ft-private-a-v1', []), /bind_refused: doc_types_empty/);
          assert.match(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT], null), /bind_refused: actor_required/);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT, CONTRACT]), 'accepted');
          const row = await slotRow(SLOT_A);
          assert.equal(row.model, 'ft-private-a-v1');
          assert.deepEqual(row.doc_types, [CONTRACT]);
          assert.equal(row.status, 'available');
          assert.equal(await value('SELECT status AS v FROM public.embedding_model_versions WHERE id = $1', ['ft-private-a-v1']), 'bound');
        });
      });

      test('the unscoped bind of 0652 still refuses a tenant-scope version', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_bind_slot($1, $2, $3)', [SLOT_A, 'ft-private-a-v1', 'op']), /tenant_scope_requires_scoping/);
        });
      });

      test('scope_slot scopes a bound empty deployment slot; a slot with rows is refused slot_not_empty; a direct doc_types update raises', async () => {
        await inTransaction(async () => {
          await register('ft-shared-v1', 'deployment', [tenantA]);
          await db.query('SELECT * FROM public.rag_finetune_bind_slot($1, $2, $3)', [SLOT_A, 'ft-shared-v1', 'op']);
          assert.match(await outcome(db, 'UPDATE public.embedding_profiles SET doc_types = $2::text[] WHERE id = $1', [SLOT_A, [CONTRACT]]), /slot_refused: scope_change_outside_bind/);
          assert.equal(await scopeSlot(SLOT_A, [CONTRACT]), 'accepted');
          assert.deepEqual((await slotRow(SLOT_A)).doc_types, [CONTRACT]);
          assert.match(await scopeSlot(SLOT_A, []), /scope_refused: doc_types_empty/);
          assert.match(await scopeSlot(SLOT_B, [CONTRACT]), /scope_refused: unbound/);
          await insertDocument(CONTRACT, 1);
          await writeSlotVectors(SLOT_A, 'ft-shared-v1', tenantA);
          assert.match(await scopeSlot(SLOT_A, [CONTRACT, GENERAL]), /scope_refused: slot_not_empty/);
        });
      });

      test('scope_slot refuses an active slot and a rollback target', async () => {
        await inTransaction(async () => {
          await register('ft-shared-v1', 'deployment', [tenantA]);
          await db.query('SELECT * FROM public.rag_finetune_bind_slot($1, $2, $3)', [SLOT_A, 'ft-shared-v1', 'op']);
          await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active'");
          await db.query("UPDATE public.embedding_profiles SET status = 'active', previous_active_id = $2 WHERE id = $1", [LEGACY, SLOT_A]);
          assert.match(await scopeSlot(SLOT_A, [CONTRACT]), /scope_refused: rollback_target/);
          await db.query("UPDATE public.embedding_profiles SET previous_active_id = NULL WHERE id = $1", [LEGACY]);
          await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE id = $1", [LEGACY]);
          await db.query("UPDATE public.embedding_profiles SET status = 'active' WHERE id = $1", [SLOT_A]);
          assert.match(await scopeSlot(SLOT_A, [CONTRACT]), /scope_refused: slot_active/);
        });
      });

      test('a slot holding a tenant-scope version never goes back to NULL doc types, not even with the slot switch set', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          assert.match(await scopeSlot(SLOT_A, null), /scope_refused: tenant_scope_requires_doc_types/);
          assert.match(await scopeSlot(SLOT_A, []), /scope_refused: tenant_scope_requires_doc_types/);
          assert.match(await outcome(db, 'UPDATE public.embedding_profiles SET doc_types = NULL WHERE id = $1', [SLOT_A]), /slot_refused/);
          await db.query('SELECT pg_catalog.set_config($1, $2, true)', [OP_GUC, 'on']);
          assert.match(await outcome(db, 'UPDATE public.embedding_profiles SET doc_types = NULL WHERE id = $1', [SLOT_A]), /slot_refused: tenant_scope_global/);
          await db.query('SELECT pg_catalog.set_config($1, $2, true)', [OP_GUC, '']);
          assert.equal(await scopeSlot(SLOT_A, [CONTRACT, GENERAL]), 'accepted', 'a re-scope that keeps a list is allowed');
        });
      });

      test('a scoped slot cannot be activated globally or take profile-level evidence (3.1.1 scope trigger, trigger B)', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          assert.match(await outcome(db, 'SELECT * FROM public.rag_activate_embedding_profile($1, $2)', [SLOT_A, 'op']), /refused/);
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET status = 'active' WHERE id = $1", [SLOT_A]), /activation_refused: scoped_profile/);
          const run = await db.query<{ id: string }>("INSERT INTO public.embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, 'completed') RETURNING id", [SLOT_A, tenantA]);
          const evidence = { target_profile: SLOT_A, baseline_profile: LEGACY, gate_passed: true, backfill_run_id: run.rows[0]?.id, recorded_at: new Date().toISOString() };
          assert.match(
            await outcome(db, 'SELECT * FROM public.rag_record_eval_evidence($1, $2::jsonb, $3)', [SLOT_A, JSON.stringify(evidence), 'op']),
            /slot_refused: tenant_scope_evidence/,
          );
        });
      });

      test('rollback never restores a scoped tenant slot (forced previous_active_id)', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          await db.query('UPDATE public.embedding_profiles SET previous_active_id = $2 WHERE id = $1', [LEGACY, SLOT_A]);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_rollback_embedding_profile($1)', ['op']), /refused/);
          assert.equal((await slotRow(SLOT_A)).status, 'available');
        });
      });
    });

    describe('re-embed of a tenant-scope slot (Task 1)', () => {
      test('a global or other-tenant run is refused; the tenant binding backfill writes only that tenant\'s vectors', async () => {
        await inTransaction(async () => {
          await insertDocument(CONTRACT, 3);
          if (multi) await insertDocument(CONTRACT, 3, SECOND_USER);
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          assert.match(await outcome(db, 'SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, null, 'op']), /reembed_refused/);
          if (multi) assert.match(await outcome(db, 'SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, tenantB, 'op']), /reembed_refused/);
          const id = await bindingId(CONTRACT, tenantA);
          await db.query('SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [id, 'backfilling', 'op']);
          const run = await db.query<{ run_id: string; chunks_total: number }>('SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, tenantA, 'op']);
          assert.equal(Number(run.rows[0]?.chunks_total), 3);
          await writeSlotVectors(SLOT_A, 'ft-private-a-v1', tenantA);
          assert.equal((await db.query('SELECT * FROM public.rag_reembed_finish_run($1, $2)', [run.rows[0]?.run_id, 'completed'])).rows.length, 1);
          assert.equal(await slotVectors(tenantA), 3);
          if (multi) assert.equal(await slotVectors(tenantB), 0, 'no vector of tenant B for the slot');
        });
      });

      test('defense in depth: with a deployment-wide binding forced in, a global run names the tenant binding backfill', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          await db.exec('ALTER TABLE public.embedding_profile_bindings DISABLE TRIGGER rag_finetune_binding_guard');
          await db.query("INSERT INTO public.embedding_profile_bindings (doc_type, tenant_key, profile_id, status, created_by) VALUES ($1, NULL, $2, 'backfilling', 'forced')", [CONTRACT, SLOT_A]);
          await db.exec('ALTER TABLE public.embedding_profile_bindings ENABLE TRIGGER rag_finetune_binding_guard');
          assert.match(await outcome(db, 'SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, null, 'op']), /reembed_refused: tenant_scope_use_binding_backfill/);
          assert.match(
            await outcome(db, "INSERT INTO public.embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, 'running')", [SLOT_A, multi ? tenantB : null]),
            /reembed_refused: tenant_scope_use_binding_backfill/,
          );
        });
      });
    });

    describe('binding guard (Task 2)', () => {
      test('tenant-scope version: the tenant binding is allowed, a deployment-wide binding and another tenant are refused', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          assert.equal(await createBinding(CONTRACT, tenantA), 'accepted');
          assert.match(await createBinding(CONTRACT, null), /binding_refused: finetune_deployment_wide/);
          if (multi) assert.match(await createBinding(CONTRACT, tenantB), /binding_refused: finetune_tenant_mismatch/);
          if (multi) {
            assert.match(
              await outcome(db, "UPDATE public.embedding_profile_bindings SET tenant_key = $1 WHERE profile_id = $2", [tenantB, SLOT_A]),
              /binding_refused: finetune_tenant_mismatch/,
            );
          }
        });
      });

      test('an unbound or tainted slot takes no binding', async () => {
        await inTransaction(async () => {
          await db.exec('SAVEPOINT scope_unbound');
          await db.query('SELECT pg_catalog.set_config($1, $2, true)', [OP_GUC, 'on']);
          await db.query('UPDATE public.embedding_profiles SET doc_types = $2::text[] WHERE id = $1', [SLOT_B, [CONTRACT]]);
          await db.query('SELECT pg_catalog.set_config($1, $2, true)', [OP_GUC, '']);
          assert.match(await createBinding(CONTRACT, tenantA, SLOT_B), /binding_refused: finetune_unbound/);
          await db.exec('ROLLBACK TO SAVEPOINT scope_unbound');
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          await db.query('SELECT * FROM public.rag_finetune_set_model_status($1, $2, $3)', ['ft-private-a-v1', 'tainted', 'op']);
          assert.match(await createBinding(CONTRACT, tenantA), /binding_refused: finetune_tainted/);
        });
      });

      test('deployment-scope version: deployment-wide and trained-tenant bindings are allowed; another tenant needs every trained tenant at deployment consent (D-33(c))', { skip: !multi }, async () => {
        await inTransaction(async () => {
          await register('ft-shared-ab-v1', 'deployment', [tenantA, tenantB]);
          assert.equal(await bindScoped(SLOT_A, 'ft-shared-ab-v1', [CONTRACT]), 'accepted');
          assert.equal(await createBinding(CONTRACT, null), 'accepted');
          assert.equal(await createBinding(CONTRACT, tenantA), 'accepted');
          assert.equal(await createBinding(CONTRACT, tenantC), 'accepted', 'tenant C: A and B both grant deployment');
          await db.query('DELETE FROM public.embedding_profile_bindings WHERE tenant_key = $1', [tenantC]);
          // The consent row itself changes (the set-consent function would also taint the version, which the next test covers).
          await db.query("UPDATE public.rag_finetune_consent SET scope = 'private' WHERE tenant_key = $1", [tenantB]);
          assert.match(await createBinding(CONTRACT, tenantC), /binding_refused: finetune_consent/);
          assert.equal(await createBinding(CONTRACT, tenantB), 'accepted', 'a trained tenant keeps its binding route');
          const id = await value<string>('SELECT id AS v FROM public.embedding_profile_bindings WHERE tenant_key = $1 AND profile_id = $2', [tenantA, SLOT_A]);
          assert.equal(await outcome(db, 'SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [id, 'backfilling', 'op']), 'accepted');
        });
      });

      test('re-checked when a binding starts serving: a binding staged before consent narrowed cannot move to backfilling', { skip: !multi }, async () => {
        await inTransaction(async () => {
          await register('ft-shared-ab-v1', 'deployment', [tenantA, tenantB]);
          assert.equal(await bindScoped(SLOT_A, 'ft-shared-ab-v1', [CONTRACT]), 'accepted');
          const id = await bindingId(CONTRACT, tenantC);
          await db.query("UPDATE public.rag_finetune_consent SET scope = 'private' WHERE tenant_key = $1", [tenantB]);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [id, 'backfilling', 'op']), /binding_refused: finetune_consent/);
          assert.equal(await outcome(db, 'SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [id, 'retired', 'op']), 'accepted');
        });
      });

      test('a non-slot profile is untouched by the guard', async () => {
        await inTransaction(async () => {
          assert.equal(await createBinding(CONTRACT, null, 'voyage-law-2-1024'), 'accepted');
        });
      });
    });

    describe('activation, taint and clear (Task 2)', () => {
      test('a private model of tenant A activates through the binding gate; the slot is never globally active', async () => {
        await inTransaction(async () => {
          await insertDocument(CONTRACT, 2);
          if (multi) await insertDocument(CONTRACT, 2, SECOND_USER);
          const id = await privateBindingActive();
          assert.equal(await value('SELECT status AS v FROM public.embedding_profile_bindings WHERE id = $1', [id]), 'active');
          assert.equal((await slotRow(SLOT_A)).status, 'available');
          assert.equal(await value("SELECT id AS v FROM public.embedding_profiles WHERE status = 'active'"), LEGACY);
          if (multi) assert.equal(await slotVectors(tenantB), 0);
        });
      });

      test('revoking consent taints the version and sets its active binding to available; no vector is deleted', async () => {
        await inTransaction(async () => {
          await insertDocument(CONTRACT, 2);
          const id = await privateBindingActive();
          const before = await slotVectors(tenantA);
          const tainted = await db.query<{ tainted_versions: string[] }>('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenantA, 'none', null, 'op']);
          assert.deepEqual(tainted.rows[0]?.tainted_versions, ['ft-private-a-v1']);
          assert.equal(await value('SELECT status AS v FROM public.embedding_profile_bindings WHERE id = $1', [id]), 'available');
          assert.equal(await slotVectors(tenantA), before);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_activate_embedding_binding($1, $2)', [id, 'op']), /binding_refused: finetune_tainted/);
        });
      });

      test('a backfilling binding of a tainted version is deactivated too; another slot\'s binding is untouched', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          await register('ft-shared-v2', 'deployment', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          assert.equal(await bindScoped(SLOT_B, 'ft-shared-v2', [GENERAL]), 'accepted');
          const idA = await bindingId(CONTRACT, tenantA, SLOT_A);
          const idB = await bindingId(GENERAL, null, SLOT_B);
          await db.query('SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [idA, 'backfilling', 'op']);
          await db.query('SELECT * FROM public.rag_set_embedding_binding_status($1, $2, $3)', [idB, 'backfilling', 'op']);
          await db.query('SELECT * FROM public.rag_finetune_set_model_status($1, $2, $3)', ['ft-private-a-v1', 'tainted', 'op']);
          assert.equal(await value('SELECT status AS v FROM public.embedding_profile_bindings WHERE id = $1', [idA]), 'available');
          assert.equal(await value('SELECT status AS v FROM public.embedding_profile_bindings WHERE id = $1', [idB]), 'backfilling');
        });
      });

      test('clear refuses while a binding of the slot serves; the emptying call deletes the slot bindings and unscopes it', async () => {
        await inTransaction(async () => {
          await insertDocument(CONTRACT, 2);
          const id = await privateBindingActive();
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, 'op', 1000]), /clear_refused: binding_active/);
          await db.query('SELECT * FROM public.rag_deactivate_embedding_binding($1, $2, $3)', [CONTRACT, tenantA, 'op']);
          const cleared = await db.query<{ cleared: boolean }>('SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, 'op', 1000]);
          assert.equal(cleared.rows[0]?.cleared, true);
          assert.equal(await value('SELECT count(*)::int AS v FROM public.embedding_profile_bindings WHERE id = $1', [id]), 0);
          const row = await slotRow(SLOT_A);
          assert.equal(row.model, 'unbound');
          assert.equal(row.doc_types, null);
          assert.equal(await value('SELECT status AS v FROM public.embedding_model_versions WHERE id = $1', ['ft-private-a-v1']), 'retired');
        });
      });
    });

    describe('grants and search_path', () => {
      test('the 0654 functions are service_role only with an empty search_path and not on the authenticated allow-list', async () => {
        for (const signature of FUNCTIONS) {
          assert.equal(allowListEntryFor(signature), undefined, signature);
          const result = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; auth: boolean; service: boolean; pub: boolean }>(
            `SELECT p.prosecdef AS definer, p.proconfig AS config,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                    EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [signature],
          );
          const row = result.rows[0];
          assert.ok(row, `${signature} exists`);
          assert.ok((row.config ?? []).includes('search_path=""'), `${signature}: ${JSON.stringify(row.config)}`);
          assert.equal(row.anon, false, signature);
          assert.equal(row.auth, false, signature);
          assert.equal(row.pub, false, signature);
          assert.equal(row.service, true, signature);
        }
      });

      test('0654 redefines none of the 3.1.1 gate, the Phase 3 activation functions or the re-embed functions', () => {
        const sql = fs.readFileSync(MIGRATION, 'utf8');
        assert.doesNotMatch(
          sql,
          /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?(rag_activate_embedding_profile|rag_rollback_embedding_profile|rag_record_eval_evidence|rag_reembed_\w+|rag_set_embedding_profile_status|rag_\w*embedding_binding\w*)\b/i,
        );
      });

      test('re-applying 0654 changes nothing', async () => {
        await inTransaction(async () => {
          await register('ft-private-a-v1', 'tenant', [tenantA]);
          assert.equal(await bindScoped(SLOT_A, 'ft-private-a-v1', [CONTRACT]), 'accepted');
          await db.exec(fs.readFileSync(MIGRATION, 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
          assert.deepEqual((await slotRow(SLOT_A)).doc_types, [CONTRACT]);
          assert.match(await createBinding(CONTRACT, null), /finetune_deployment_wide/);
        });
      });
    });
  });
}

// Task 3 and the serving path: the CLI route for a private model of tenant A, on the real search through the fake edge (multi-tenant,
// two tenants with identical contract chunks). Every endpoint is a local fake.
describe('ft-bind --doc-types and the binding route end to end (multi-tenant, two tenants)', () => {
  const VERSION = 'ft-private-contract-a1';
  const QUERY = 'which numbered steps does the sample widget record list';
  const PASSAGE = 'Neutral sample passage: the widget record lists seven numbered steps for the routine.';
  let harness: import('../helpers/finetune-lifecycle.mts').Harness;
  let helpers: typeof import('../helpers/finetune-lifecycle.mts');
  let bindings: typeof import('@/lib/rag/embeddings/bindings');
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  const chunksOf: Record<string, string[]> = {};
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    RAG_PIPELINE: 'v2',
    RAG_LEXICAL_SEARCH: 'false',
    RAG_RERANKER: 'none',
    RAG_REFUSAL_THRESHOLD: 'false',
    RAG_EMBEDDING_PROFILES: 'on',
    RAG_DOMAIN_EMBEDDINGS: 'on',
  };

  before(async () => {
    for (const name of Object.keys(ENV)) saved[name] = process.env[name];
    Object.assign(process.env, ENV);
    helpers = await import('../helpers/finetune-lifecycle.mts');
    harness = await helpers.startHarness();
    bindings = await import('@/lib/rag/embeddings/bindings');
    const twoTenant = await import('../../eval/harness/two-tenant.mts');
    userA = twoTenant.TWO_TENANT_IDS.userA;
    userB = twoTenant.TWO_TENANT_IDS.userB;
    tenantA = `u:${userA}`;
    tenantB = `u:${userB}`;
    db = (await twoTenant.createTwoTenantDatabase()).db;
    for (const userId of [userA, userB]) {
      const documentId = crypto.randomUUID();
      await db.query('INSERT INTO documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
        documentId,
        'contract-identical.md',
        PASSAGE,
        '{}',
        userId,
        CONTRACT,
      ]);
      for (let index = 0; index < 2; index += 1) {
        await db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
          crypto.randomUUID(),
          documentId,
          `Document: contract-identical.md. Chunk ${index + 1} of 2. Content: ${PASSAGE}`,
          index,
          '{}',
        ]);
      }
    }
    await helpers.installFixtureProductionModel(db);
    for (const tenant of [tenantA, tenantB]) {
      chunksOf[tenant] = (await helpers.rowsOf(db, 'SELECT id FROM document_chunks WHERE tenant_key = $1', [tenant])).map((row) => String(row.id));
    }
    await harness.use(db, 'multi-tenant');
    await helpers.resetFinetuneState(db);
    harness.setFinetune(true);
    // setProfilesSwitch would replace the ingest env without RAG_DOMAIN_EMBEDDINGS; the binding route needs both switches on.
    harness.ingestConfig.resetIngestConfigForTests();
    harness.ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: 'on' }) });
    harness.activeProfile.resetActiveProfileForTests();
    harness.env.RAG_FT_SLOT_A_MODEL = VERSION;
  });

  after(async () => {
    for (const [name, saved_] of Object.entries(saved)) {
      if (saved_ === undefined) delete process.env[name];
      else process.env[name] = saved_;
    }
    bindings?.resetBindingsForTests();
    await harness?.close();
    await db?.close();
  });

  const rpcCalls = (fn: string): number => harness.edge.calls.filter((call) => call.path.endsWith(`/rpc/${fn}`)).length;
  const slotVectors = async (tenant: string): Promise<number> =>
    Number((await helpers.rowsOf(db, 'SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1 AND tenant_key = $2', [SLOT_A, tenant]))[0]?.n);

  async function retrieve(userId: string) {
    harness.resetCaches();
    bindings.resetBindingsForTests();
    const resolved = await harness.rag.resolveTenantScope({ deploymentMode: 'multi-tenant', getUser: async () => ({ id: userId }), signal: new AbortController().signal });
    assert.ok(resolved.ok && resolved.scope);
    harness.endpoints.calls.length = 0;
    return harness.rag.runRetrieval({
      scope: resolved.scope,
      query: QUERY,
      profile: 'chat',
      options: { maxResults: 25, ragMode: 'balanced' },
      signal: new AbortController().signal,
    });
  }

  test('a private model of A serves only A, through its tenant binding; every other route is refused', async () => {
    assert.equal((await harness.embedding('ft-consent', 'grant', tenantA, '--scope', 'private', '--ref', 'TICKET-3001')).code, 0);
    const cardFile = helpers.writeJson(harness.workDir, VERSION, helpers.modelCard(VERSION, [tenantA], { scope: 'tenant' }));
    const registered = await harness.embedding('ft-models', 'register', cardFile);
    assert.equal(registered.code, 0, registered.text);

    harness.edge.calls.length = 0;
    const unscoped = await harness.embedding('ft-bind', SLOT_A, VERSION);
    assert.equal(unscoped.code, 1, unscoped.text);
    assert.match(unscoped.text, /--doc-types/);
    assert.equal(rpcCalls('rag_finetune_bind_slot') + rpcCalls('rag_finetune_bind_scoped_slot'), 0, 'refused before any bind RPC');

    const bound = await harness.embedding('ft-bind', SLOT_A, VERSION, '--doc-types', CONTRACT);
    assert.equal(bound.code, 0, bound.text);
    assert.match(bound.text, new RegExp(`scoped to ${CONTRACT}`));
    assert.ok(bound.text.includes(`npm run rag:embedding -- bind ${CONTRACT} ${SLOT_A} --tenant ${tenantA}`), bound.text);
    assert.ok(bound.text.includes(`npm run rag:reembed -- --profile ${SLOT_A} --tenant ${tenantA}`), bound.text);
    assert.doesNotMatch(bound.text, new RegExp(`rag:reembed -- --profile ${SLOT_A}(?! --tenant)`));
    assert.doesNotMatch(bound.text, /rag:embedding -- activate (?!-binding)/);
    assert.deepEqual((await helpers.rowsOf(db, 'SELECT doc_types FROM embedding_profiles WHERE id = $1', [SLOT_A]))[0]?.doc_types, [CONTRACT]);

    const globalActivation = await harness.embedding('activate', SLOT_A);
    assert.equal(globalActivation.code, 1, 'a scoped slot is never activated globally');

    const forB = await harness.embedding('bind', CONTRACT, SLOT_A, '--tenant', tenantB);
    assert.equal(forB.code, 1, forB.text);
    assert.match(forB.text, /finetune_tenant_mismatch/);
    const deploymentWide = await harness.embedding('bind', CONTRACT, SLOT_A);
    assert.equal(deploymentWide.code, 1, deploymentWide.text);
    assert.match(deploymentWide.text, /finetune_deployment_wide/);

    const forA = await harness.embedding('bind', CONTRACT, SLOT_A, '--tenant', tenantA);
    assert.equal(forA.code, 0, forA.text);
    const bindingId = String((await helpers.rowsOf(db, 'SELECT id FROM embedding_profile_bindings WHERE profile_id = $1 AND tenant_key = $2', [SLOT_A, tenantA]))[0]?.id);
    assert.equal((await harness.embedding('bind-status', bindingId, 'backfilling')).code, 0);

    const global = await harness.reembed('--profile', SLOT_A, '--batch-size', '8');
    assert.notEqual(global.code, 0, 'a global re-embed of the private slot is refused');
    assert.equal(await slotVectors(tenantB), 0);
    const backfill = await harness.reembed('--profile', SLOT_A, '--tenant', tenantA, '--batch-size', '8');
    assert.equal(backfill.code, 0, backfill.text);
    assert.equal(await slotVectors(tenantA), 2);
    assert.equal(await slotVectors(tenantB), 0, 'identical chunks of tenant B got no vector of the private model');

    const runId = String((await helpers.rowsOf(db, "SELECT id FROM embedding_backfill_runs WHERE profile_id = $1 AND status = 'completed'", [SLOT_A]))[0]?.id);
    const evidence = {
      binding_id: bindingId,
      target_profile: SLOT_A,
      doc_type: CONTRACT,
      tenant_key: tenantA,
      baseline_global_profile: LEGACY,
      baseline_binding_profile: null,
      gate_passed: true,
      doc_type_slice: { n: 40, real_n: 40, passed: true, by_language: { en: true } },
      other_slices_passed: true,
      backfill_run_id: runId,
      recorded_at: new Date().toISOString(),
    };
    await db.query('SELECT * FROM rag_record_binding_evidence($1, $2::jsonb, $3)', [bindingId, JSON.stringify(evidence), 'test']);
    const activated = await harness.embedding('activate-binding', bindingId);
    assert.equal(activated.code, 0, activated.text);

    const servedA = await retrieve(userA);
    assert.notEqual(servedA.status, 'error', servedA.reason);
    const ftCallsA = harness.endpoints.callsFor('ft');
    assert.ok(ftCallsA.length > 0, "A's query reached the private model through the binding leg");
    const bodies = ftCallsA.map((call) => JSON.stringify(call.body));
    assert.ok(bodies.some((body) => body.includes(QUERY)), "the private model embedded tenant A's query");
    assert.ok(
      bodies.every((body) => body.includes(QUERY) || helpers.PROBE_TEXTS.some((probe) => body.includes(probe))),
      "the private model saw only tenant A's query and its own registered probe texts",
    );
    assert.ok(servedA.candidates.every((row) => !chunksOf[tenantB]!.includes(row.chunk_id)), 'A sees none of B');
    assert.ok(servedA.candidates.some((row) => chunksOf[tenantA]!.includes(row.chunk_id)));

    const servedB = await retrieve(userB);
    assert.notEqual(servedB.status, 'error', servedB.reason);
    assert.deepEqual(harness.endpoints.callsFor('ft'), [], "B's queries never use the slot");
    assert.ok(servedB.candidates.every((row) => !chunksOf[tenantA]!.includes(row.chunk_id)), 'B sees none of A');

    const revoked = await harness.embedding('ft-consent', 'revoke', tenantA);
    assert.equal(revoked.code, 0, revoked.text);
    assert.ok(revoked.text.includes(`binding ${bindingId} (${CONTRACT}, ${tenantA}) of ${SLOT_A} was active and is now available`), revoked.text);
    assert.equal((await helpers.rowsOf(db, 'SELECT status FROM embedding_profile_bindings WHERE id = $1', [bindingId]))[0]?.status, 'available');

    const fallback = await retrieve(userA);
    assert.notEqual(fallback.status, 'error', fallback.reason);
    assert.deepEqual(harness.endpoints.callsFor('ft'), [], 'after the taint A falls back to the global profile');
  });
});
