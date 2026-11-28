import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { allowListEntryFor } from '../helpers/security-definer-allow-list';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0652_finetune_slots.sql');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

const SLOT_A = 'ft-a-1024';
const SLOT_B = 'ft-b-1024';
const LEGACY = 'openai-3-small-1536';
const SECOND_USER = '22222222-2222-4222-8222-222222222222';
const OP_GUC = 'myrag.ft_slot_op';

const FUNCTIONS = [
  'public.rag_finetune_bind_slot(text, text, text)',
  'public.rag_finetune_clear_slot(text, text, integer)',
  'public.rag_finetune_release_rollback(text, text)',
  'public.rag_finetune_version_taint_guard()',
  'public.rag_finetune_slot_guard()',
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

interface SlotRow {
  id: string;
  provider: string;
  model: string;
  dims: number;
  storage: string;
  status: string;
  query_instruction: string | null;
  eval_evidence: Record<string, unknown> | null;
  previous_active_id: string | null;
  doc_types: string[] | null;
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';

  describe(`0652 fine-tune slots (${mode})`, () => {
    let db: PGlite;
    let tenantA: string;
    let tenantB: string;
    let ownerA: string;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      ownerA = fixture.fixtureUserId;
      tenantA = multi ? `u:${ownerA}` : 's:default';
      tenantB = `u:${SECOND_USER}`;
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SECOND_USER, 'second-user@example.invalid']);
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

    async function slot(id: string): Promise<SlotRow> {
      const result = await db.query<SlotRow>(
        'SELECT id, provider, model, dims, storage, status, query_instruction, eval_evidence, previous_active_id, doc_types FROM public.embedding_profiles WHERE id = $1',
        [id],
      );
      const row = result.rows[0];
      assert.ok(row, `profile ${id} is missing`);
      return row;
    }

    async function version(id: string): Promise<{ status: string; bound_slot: string | null }> {
      const result = await db.query<{ status: string; bound_slot: string | null }>('SELECT status, bound_slot FROM public.embedding_model_versions WHERE id = $1', [id]);
      const row = result.rows[0];
      assert.ok(row, `version ${id} is missing`);
      return row;
    }

    async function grant(tenant: string, scope: 'private' | 'deployment'): Promise<void> {
      await db.query('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenant, scope, 'TICKET-1', 'op']);
    }

    async function revoke(tenant: string): Promise<string[]> {
      const result = await db.query<{ tainted_versions: string[] }>('SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [tenant, 'none', null, 'op']);
      return result.rows[0]?.tainted_versions ?? [];
    }

    async function registerVersion(id: string, scope: 'deployment' | 'tenant' = 'deployment', tenants: string[] = [tenantA]): Promise<void> {
      for (const tenant of tenants) await grant(tenant, 'deployment');
      await db.query('SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', [JSON.stringify(card(id, scope, tenants)), 'op']);
    }

    const bind = (slotId: string, versionId: string, actor: string | null = 'op'): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_finetune_bind_slot($1, $2, $3)', [slotId, versionId, actor]);

    async function insertDocument(chunks: number, owner: string = ownerA): Promise<string[]> {
      const documentId = crypto.randomUUID();
      if (multi) {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          documentId,
          `slot-${documentId.slice(0, 8)}.md`,
          'A neutral synthetic paragraph about a sample record.',
          '{}',
          owner,
        ]);
      } else {
        await db.query('INSERT INTO public.documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
          documentId,
          `slot-${documentId.slice(0, 8)}.md`,
          'A neutral synthetic paragraph about a sample record.',
          '{}',
        ]);
      }
      const ids: string[] = [];
      for (let index = 0; index < chunks; index += 1) {
        const chunkId = crypto.randomUUID();
        await db.query(
          "INSERT INTO public.document_chunks (id, document_id, content, chunk_index, metadata, embedding) VALUES ($1, $2, $3, $4, $5::jsonb, array_fill(0.01::float4, ARRAY[1536])::public.vector)",
          [
          chunkId,
          documentId,
          `A neutral synthetic sentence number ${index}.`,
          index,
          '{}',
          ],
        );
        ids.push(chunkId);
      }
      return ids;
    }

    async function insertVectors(chunkIds: string[], profileId: string, model: string, embeddedAt = "now() - interval '2 hours'"): Promise<void> {
      for (const chunkId of chunkIds) {
        await db.query(
          `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
           SELECT c.id, $2, c.tenant_key, $3::public.halfvec, $4, 1024, ${embeddedAt} FROM public.document_chunks c WHERE c.id = $1`,
          [chunkId, profileId, vectorLiteral(), model],
        );
      }
    }

    /** Vectors of the slot's model for every current ready chunk, two hours old. */
    async function fillSlot(profileId: string, model: string): Promise<void> {
      await db.query(
        `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
         SELECT c.id, $1, c.tenant_key, $2::public.halfvec, $3, 1024, now() - interval '2 hours'
         FROM public.document_chunks c WHERE c.is_current AND c.status = 'ready'
         ON CONFLICT DO NOTHING`,
        [profileId, vectorLiteral(), model],
      );
    }

    async function vectorCount(profileId: string, tenant?: string): Promise<number> {
      const result = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.chunk_embeddings WHERE profile_id = $1 AND ($2::text IS NULL OR tenant_key = $2)',
        [profileId, tenant ?? null],
      );
      return result.rows[0]?.n ?? 0;
    }

    async function forceActive(profileId: string, previous: string | null): Promise<void> {
      await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active'");
      await db.query("UPDATE public.embedding_profiles SET status = 'active', previous_active_id = $2 WHERE id = $1", [profileId, previous]);
    }

    // A run row of a slot holding a tenant-scope version must name that tenant (0654 backfill-run guard), so the forced-state test passes one.
    async function evidenceFor(profileId: string, runTenant: string | null = null): Promise<Record<string, unknown>> {
      const run = await db.query<{ id: string }>("INSERT INTO public.embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, $2, 'completed') RETURNING id", [
        profileId,
        runTenant,
      ]);
      return {
        target_profile: profileId,
        baseline_profile: LEGACY,
        gate_passed: true,
        pre_migration: { passed: true, n: 12 },
        backfill_run_id: run.rows[0]?.id,
        recorded_at: new Date(Date.now() - 3600_000).toISOString(),
      };
    }

    const recordEvidence = async (profileId: string, evidence?: Record<string, unknown>): Promise<string> =>
      outcome(db, 'SELECT * FROM public.rag_record_eval_evidence($1, $2::jsonb, $3)', [profileId, JSON.stringify(evidence ?? (await evidenceFor(profileId))), 'op']);

    const activate = (profileId: string): Promise<string> => outcome(db, 'SELECT * FROM public.rag_activate_embedding_profile($1, $2)', [profileId, 'op']);

    describe('slot rows, indexes and bind', () => {
      test('both slot rows exist unbound, available, halfvec 1024, unscoped, with their providers', async () => {
        for (const [id, provider] of [[SLOT_A, 'ft_slot_a'], [SLOT_B, 'ft_slot_b']] as const) {
          const row = await slot(id);
          assert.equal(row.provider, provider);
          assert.equal(row.model, 'unbound');
          assert.equal(row.dims, 1024);
          assert.equal(row.storage, 'halfvec');
          assert.equal(row.status, 'available');
          assert.equal(row.query_instruction, null);
          assert.equal(row.eval_evidence, null);
          assert.equal(row.doc_types, null);
        }
      });

      test('each slot has its partial halfvec(1024) HNSW index with m = 64 and ef_construction = 200', async () => {
        for (const [index, id] of [['chunk_embeddings_ft_a_1024_hnsw', SLOT_A], ['chunk_embeddings_ft_b_1024_hnsw', SLOT_B]] as const) {
          const result = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [index]);
          const definition = result.rows[0]?.indexdef ?? '';
          assert.match(definition, /USING hnsw/, index);
          assert.match(definition, /halfvec\(1024\)/, index);
          assert.match(definition, /halfvec_cosine_ops/, index);
          assert.match(definition, /m='?64'?/, index);
          assert.match(definition, /ef_construction='?200'?/, index);
          assert.match(definition, new RegExp(`WHERE \\(profile_id = '${id}'::text\\)`), index);
        }
      });

      test('re-applying 0652 changes nothing, also on a bound slot', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-reapply-v1');
          assert.equal(await bind(SLOT_A, 'ft-reapply-v1'), 'accepted');
          const before = await db.query('SELECT * FROM public.embedding_profiles WHERE id LIKE $1 ORDER BY id', ['ft-%']);
          await db.exec(fs.readFileSync(MIGRATION, 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, ''));
          const afterRows = await db.query('SELECT * FROM public.embedding_profiles WHERE id LIKE $1 ORDER BY id', ['ft-%']);
          assert.deepEqual(afterRows.rows, before.rows);
        });
      });

      test('bind sets model and query_instruction from the version and binds the version; nothing else changes and no vector is written', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-bind-v1');
          assert.equal(await bind(SLOT_A, 'ft-bind-v1'), 'accepted');
          const row = await slot(SLOT_A);
          assert.equal(row.model, 'ft-bind-v1');
          assert.equal(row.query_instruction, 'query prompt of ft-bind-v1: ');
          assert.equal(row.status, 'available');
          assert.equal(row.eval_evidence, null);
          assert.deepEqual(await version('ft-bind-v1'), { status: 'bound', bound_slot: SLOT_A });
          assert.equal(await vectorCount(SLOT_A), 0);
          assert.equal((await slot(SLOT_B)).model, 'unbound');
          const setting = await db.query<{ v: string | null }>('SELECT current_setting($1, true) AS v', [OP_GUC]);
          assert.notEqual(setting.rows[0]?.v, 'on', 'bind must not leave the slot operation switch on for the rest of the transaction');
        });
      });

      test('bind refuses: actor, unknown slot, non-slot profile, unknown version, version_bound, slot_not_empty, slot_bound', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-refuse-v1');
          await registerVersion('ft-refuse-v2');
          assert.match(await bind(SLOT_A, 'ft-refuse-v1', null), /bind_refused: actor_required/);
          assert.match(await bind('ft-c-1024', 'ft-refuse-v1'), /bind_refused: unknown_slot/);
          assert.match(await bind('voyage-4-large-1024', 'ft-refuse-v1'), /bind_refused: unknown_slot/);
          assert.match(await bind(SLOT_A, 'ft-missing-v9'), /bind_refused: unknown_version/);
          assert.equal(await bind(SLOT_A, 'ft-refuse-v1'), 'accepted');
          assert.match(await bind(SLOT_B, 'ft-refuse-v1'), /bind_refused: version_bound/);
          assert.match(await bind(SLOT_A, 'ft-refuse-v2'), /bind_refused: slot_bound/);
          const chunks = await insertDocument(1);
          await insertVectors(chunks, SLOT_A, 'ft-refuse-v1');
          assert.match(await bind(SLOT_A, 'ft-refuse-v2'), /bind_refused: slot_not_empty/);
          assert.equal((await slot(SLOT_A)).model, 'ft-refuse-v1');
          assert.equal((await version('ft-refuse-v2')).status, 'registered');
        });
      });

      test('bind refuses a retired or tainted version (version_status)', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-status-v1');
          await registerVersion('ft-status-v2');
          await db.query('SELECT * FROM public.rag_finetune_set_model_status($1, $2, $3)', ['ft-status-v1', 'retired', 'op']);
          await db.query('SELECT * FROM public.rag_finetune_set_model_status($1, $2, $3)', ['ft-status-v2', 'tainted', 'op']);
          assert.match(await bind(SLOT_A, 'ft-status-v1'), /bind_refused: version_status/);
          assert.match(await bind(SLOT_A, 'ft-status-v2'), /bind_refused: version_status/);
          assert.equal((await slot(SLOT_A)).model, 'unbound');
        });
      });

      test('bind refuses the active slot (slot_active) and the rollback target (rollback_target)', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-active-v1');
          await registerVersion('ft-active-v2');
          assert.equal(await bind(SLOT_A, 'ft-active-v1'), 'accepted');
          await forceActive(SLOT_A, LEGACY);
          assert.match(await bind(SLOT_A, 'ft-active-v2'), /bind_refused: slot_active/);
        });
        await inTransaction(async () => {
          await registerVersion('ft-rollback-v1');
          assert.equal(await bind(SLOT_B, 'ft-rollback-v1'), 'accepted');
          await forceActive(SLOT_B, SLOT_A);
          await registerVersion('ft-rollback-v2');
          assert.match(await bind(SLOT_A, 'ft-rollback-v2'), /bind_refused: rollback_target/);
        });
      });

      test('bind refuses while a re-embed run of the slot is running (reembed_running)', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-running-v1');
          await db.query("INSERT INTO public.embedding_backfill_runs (profile_id, status) VALUES ($1, 'running')", [SLOT_A]);
          assert.match(await bind(SLOT_A, 'ft-running-v1'), /bind_refused: reembed_running/);
        });
      });

      test('bind refuses a tenant-scope version: only the scoped bind may bind it (tenant_scope_requires_scoping)', async () => {
        await inTransaction(async () => {
          await grant(tenantA, 'private');
          await db.query('SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', [JSON.stringify(card('ft-private-v1', 'tenant', [tenantA])), 'op']);
          assert.match(await bind(SLOT_A, 'ft-private-v1'), /bind_refused: tenant_scope_requires_scoping/);
          assert.equal((await slot(SLOT_A)).model, 'unbound');
          assert.equal((await version('ft-private-v1')).status, 'registered');
        });
      });

      test('a direct model or prompt change of a slot outside bind/clear is refused, also as service_role', async () => {
        await inTransaction(async () => {
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET model = 'x' WHERE id = $1", [SLOT_A]), /slot_refused: model_change_outside_bind/);
          await db.exec('SET LOCAL ROLE service_role');
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET model = 'x' WHERE id = $1", [SLOT_A]), /slot_refused: model_change_outside_bind/);
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET query_instruction = 'x' WHERE id = $1", [SLOT_B]), /slot_refused: model_change_outside_bind/);
          assert.match(await outcome(db, 'UPDATE public.embedding_profiles SET dims = 512 WHERE id = $1', [SLOT_B]), /slot_refused: model_change_outside_bind/);
          await db.exec('RESET ROLE');
        });
      });

      test('a slot row cannot be re-created bound or with evidence after a delete', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-insert-v1');
          await db.query('DELETE FROM public.embedding_profiles WHERE id = $1', [SLOT_B]);
          const insert = (model: string, evidence: string | null) =>
            outcome(
              db,
              "INSERT INTO public.embedding_profiles (id, provider, model, dims, storage, status, eval_evidence) VALUES ($1, 'ft_slot_b', $2, 1024, 'halfvec', 'available', $3::jsonb)",
              [SLOT_B, model, evidence],
            );
          assert.match(await insert('ft-insert-v1', null), /slot_refused: model_change_outside_bind/);
          assert.match(await insert('unbound', '{"target_profile":"ft-b-1024"}'), /slot_refused/);
        });
      });

      test('an unbound slot cannot take evidence, be backfilled or be activated', async () => {
        await inTransaction(async () => {
          assert.match(await recordEvidence(SLOT_A), /slot_refused: evidence_without_version/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_set_embedding_profile_status($1, $2, $3)', [SLOT_A, 'backfilling', 'op']), /slot_refused: unbound/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, null, 'op']), /slot_refused: unbound/);
        });
      });

      test('no global path for a private model: an unscoped slot holding a tenant-scope version refuses evidence, backfilling and activation (forced state)', async () => {
        await inTransaction(async () => {
          await grant(tenantA, 'private');
          await db.query('SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', [JSON.stringify(card('ft-forced-v1', 'tenant', [tenantA])), 'op']);
          await db.query('SELECT pg_catalog.set_config($1, $2, true)', [OP_GUC, 'on']);
          await db.query("UPDATE public.embedding_profiles SET model = 'ft-forced-v1', query_instruction = 'q' WHERE id = $1", [SLOT_A]);
          await db.query("UPDATE public.embedding_model_versions SET status = 'bound', bound_slot = $1 WHERE id = 'ft-forced-v1'", [SLOT_A]);
          assert.match(await recordEvidence(SLOT_A, await evidenceFor(SLOT_A, tenantA)), /slot_refused: tenant_scope_global/);
          await db.query('SELECT pg_catalog.set_config($1, $2, true)', [OP_GUC, '']);
          assert.match(await recordEvidence(SLOT_A, await evidenceFor(SLOT_A, tenantA)), /slot_refused: tenant_scope_global/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_set_embedding_profile_status($1, $2, $3)', [SLOT_A, 'backfilling', 'op']), /slot_refused: tenant_scope_global/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_reembed_start_run($1, $2, $3)', [SLOT_A, null, 'op']), /slot_refused: tenant_scope_global/);
          await insertDocument(2);
          await fillSlot(SLOT_A, 'ft-forced-v1');
          assert.match(await activate(SLOT_A), /activation_refused: eval_missing/);
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active'"), /accepted/);
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET status = 'active' WHERE id = $1", [SLOT_A]), /slot_refused: tenant_scope_global/);
        });
      });
    });

    describe('clear, release-rollback and taint', () => {
      const clear = (slotId: string, limit: number, actor: string | null = 'op') =>
        db.query<{ slot_id: string; deleted: number; remaining: number; cleared: boolean }>('SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [slotId, actor, limit]);

      test('clear deletes in batches and resets the slot when no vector is left; the version is retired and the slot can be bound again', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-clear-v1');
          assert.equal(await bind(SLOT_A, 'ft-clear-v1'), 'accepted');
          await insertVectors(await insertDocument(5), SLOT_A, 'ft-clear-v1');
          const first = (await clear(SLOT_A, 2)).rows[0];
          assert.deepEqual({ deleted: Number(first?.deleted), remaining: Number(first?.remaining), cleared: first?.cleared }, { deleted: 2, remaining: 3, cleared: false });
          assert.equal((await slot(SLOT_A)).model, 'ft-clear-v1');
          const second = (await clear(SLOT_A, 2)).rows[0];
          assert.deepEqual({ deleted: Number(second?.deleted), remaining: Number(second?.remaining), cleared: second?.cleared }, { deleted: 2, remaining: 1, cleared: false });
          const third = (await clear(SLOT_A, 2)).rows[0];
          assert.deepEqual({ deleted: Number(third?.deleted), remaining: Number(third?.remaining), cleared: third?.cleared }, { deleted: 1, remaining: 0, cleared: true });
          const row = await slot(SLOT_A);
          assert.equal(row.model, 'unbound');
          assert.equal(row.query_instruction, null);
          assert.equal(row.eval_evidence, null);
          assert.equal(row.status, 'available');
          assert.deepEqual(await version('ft-clear-v1'), { status: 'retired', bound_slot: null });
          await registerVersion('ft-clear-v2');
          assert.equal(await bind(SLOT_A, 'ft-clear-v2'), 'accepted');
        });
      });

      test('clear resets a backfilling slot and drops its evidence', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-clear-backfill-v1');
          assert.equal(await bind(SLOT_A, 'ft-clear-backfill-v1'), 'accepted');
          await insertVectors(await insertDocument(1), SLOT_A, 'ft-clear-backfill-v1');
          assert.equal(await recordEvidence(SLOT_A), 'accepted');
          await db.query('SELECT * FROM public.rag_set_embedding_profile_status($1, $2, $3)', [SLOT_A, 'backfilling', 'op']);
          assert.equal((await clear(SLOT_A, 1000)).rows[0]?.cleared, true);
          const row = await slot(SLOT_A);
          assert.equal(row.status, 'available');
          assert.equal(row.eval_evidence, null);
        });
      });

      test('clear refuses: actor, limit, unknown slot, the active slot, the rollback target, a running re-embed', async () => {
        await inTransaction(async () => {
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, null, 10]), /clear_refused: actor_required/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, 'op', 0]), /clear_refused: invalid_limit/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', ['voyage-4-large-1024', 'op', 10]), /clear_refused: unknown_slot/);
          await registerVersion('ft-clear-active-v1');
          assert.equal(await bind(SLOT_A, 'ft-clear-active-v1'), 'accepted');
          await forceActive(SLOT_A, LEGACY);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, 'op', 10]), /clear_refused: slot_active/);
          await forceActive(LEGACY, SLOT_B);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_B, 'op', 10]), /clear_refused: rollback_target/);
          await db.query("INSERT INTO public.embedding_backfill_runs (profile_id, status) VALUES ($1, 'running')", [SLOT_A]);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, 'op', 10]), /clear_refused: reembed_running/);
        });
      });

      test('clear is slot-wide: with two tenants, partial calls may leave either tenant, the final call leaves none and touches no other profile', { skip: !multi }, async () => {
        await inTransaction(async () => {
          await registerVersion('ft-two-v1', 'deployment', [tenantA, tenantB]);
          assert.equal(await bind(SLOT_A, 'ft-two-v1'), 'accepted');
          assert.equal(await vectorCount(SLOT_A), 0, 'bind writes no vector');
          const chunksA = await insertDocument(2, ownerA);
          const chunksB = await insertDocument(2, SECOND_USER);
          await insertVectors([...chunksA, ...chunksB], SLOT_A, 'ft-two-v1');
          await insertVectors(chunksB, 'voyage-4-large-1024', 'voyage-4-large');
          assert.equal(await vectorCount(SLOT_A, tenantB), 2);
          assert.equal((await clear(SLOT_A, 3)).rows[0]?.cleared, false);
          assert.equal((await clear(SLOT_A, 3)).rows[0]?.cleared, true);
          assert.equal(await vectorCount(SLOT_A, tenantA), 0);
          assert.equal(await vectorCount(SLOT_A, tenantB), 0);
          assert.equal(await vectorCount('voyage-4-large-1024', tenantB), 2);
        });
      });

      test('release_rollback needs the explicit acknowledgement and returns the dropped id', async () => {
        await inTransaction(async () => {
          await db.query('UPDATE public.embedding_profiles SET previous_active_id = $2 WHERE id = $1', [LEGACY, SLOT_B]);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_release_rollback($1, $2)', ['op', 'yes']), /release_refused: ack_required/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_release_rollback($1, $2)', ['op', null]), /release_refused: ack_required/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_release_rollback($1, $2)', [null, 'drop-rollback']), /release_refused: actor_required/);
          const released = await db.query<{ active_profile: string; dropped_previous: string | null }>('SELECT * FROM public.rag_finetune_release_rollback($1, $2)', [
            'op',
            'drop-rollback',
          ]);
          assert.deepEqual(released.rows[0], { active_profile: LEGACY, dropped_previous: SLOT_B });
          assert.equal((await slot(LEGACY)).previous_active_id, null);
          const again = await db.query<{ dropped_previous: string | null }>('SELECT * FROM public.rag_finetune_release_rollback($1, $2)', ['op', 'drop-rollback']);
          assert.equal(again.rows[0]?.dropped_previous, null);
          assert.equal(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_B, 'op', 10]), 'accepted');
        });
      });

      test('revoking consent taints the version and drops the evidence of its non-active slot; activation then refuses eval_missing', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-taint-v1');
          assert.equal(await bind(SLOT_A, 'ft-taint-v1'), 'accepted');
          await insertDocument(2);
          await fillSlot(SLOT_A, 'ft-taint-v1');
          assert.equal(await recordEvidence(SLOT_A), 'accepted');
          assert.notEqual((await slot(SLOT_A)).eval_evidence, null);
          assert.deepEqual(await revoke(tenantA), ['ft-taint-v1']);
          assert.equal((await version('ft-taint-v1')).status, 'tainted');
          assert.equal((await slot(SLOT_A)).eval_evidence, null);
          assert.match(await activate(SLOT_A), /activation_refused: eval_missing/);
          assert.match(await recordEvidence(SLOT_A), /slot_refused: version_tainted/);
          assert.match(await outcome(db, "UPDATE public.embedding_profiles SET status = 'active' WHERE id = $1", [SLOT_A]), /slot_refused: version_tainted/);
        });
      });

      test('a tainted active slot keeps its evidence; leaving active drops it, and a rollback to a tainted slot is refused', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-live-v1');
          assert.equal(await bind(SLOT_A, 'ft-live-v1'), 'accepted');
          await insertDocument(2);
          await fillSlot(SLOT_A, 'ft-live-v1');
          assert.equal(await recordEvidence(SLOT_A), 'accepted');
          assert.equal(await activate(SLOT_A), 'accepted');
          assert.equal((await slot(SLOT_A)).status, 'active');
          assert.deepEqual(await revoke(tenantA), ['ft-live-v1']);
          assert.notEqual((await slot(SLOT_A)).eval_evidence, null, 'the active slot keeps its evidence');
          assert.equal(await outcome(db, 'SELECT * FROM public.rag_rollback_embedding_profile($1)', ['op']), 'accepted');
          const left = await slot(SLOT_A);
          assert.equal(left.status, 'available');
          assert.equal(left.eval_evidence, null, 'leaving active drops the evidence of a tainted slot');
          await db.query('UPDATE public.embedding_profiles SET previous_active_id = $2 WHERE id = $1', [LEGACY, SLOT_A]);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_rollback_embedding_profile($1)', ['op']), /slot_refused: version_tainted/);
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_clear_slot($1, $2, $3)', [SLOT_A, 'op', 1000]), /clear_refused: rollback_target/);
          await db.query('SELECT * FROM public.rag_finetune_release_rollback($1, $2)', ['op', 'drop-rollback']);
          assert.equal((await clear(SLOT_A, 1000)).rows[0]?.cleared, true);
          assert.deepEqual(await version('ft-live-v1'), { status: 'tainted', bound_slot: null });
        });
      });

      test('a taint never touches another slot or a non-slot profile', async () => {
        await inTransaction(async () => {
          await registerVersion('ft-iso-v1');
          await registerVersion('ft-iso-v2');
          assert.equal(await bind(SLOT_A, 'ft-iso-v1'), 'accepted');
          assert.equal(await bind(SLOT_B, 'ft-iso-v2'), 'accepted');
          await insertVectors(await insertDocument(1), SLOT_A, 'ft-iso-v1');
          await insertVectors(await insertDocument(1), SLOT_B, 'ft-iso-v2');
          assert.equal(await recordEvidence(SLOT_A), 'accepted');
          assert.equal(await recordEvidence(SLOT_B), 'accepted');
          await db.query('SELECT * FROM public.rag_finetune_set_model_status($1, $2, $3)', ['ft-iso-v1', 'tainted', 'op']);
          assert.equal((await slot(SLOT_A)).eval_evidence, null);
          assert.notEqual((await slot(SLOT_B)).eval_evidence, null);
        });
      });
    });

    describe('grants and search_path', () => {
      test('the slot functions are service_role only, SECURITY DEFINER with an empty search_path, and not on the authenticated allow-list', async () => {
        for (const signature of FUNCTIONS) {
          assert.equal(allowListEntryFor(signature), undefined, signature);
          const result = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; authed: boolean; service: boolean; pub: boolean }>(
            `SELECT p.prosecdef AS definer, p.proconfig AS config,
                    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                    EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
            [signature],
          );
          const row = result.rows[0];
          assert.ok(row, `${signature} is missing`);
          assert.equal(row.definer, true, signature);
          assert.ok((row.config ?? []).includes('search_path=""'), `${signature}: ${JSON.stringify(row.config)}`);
          assert.equal(row.anon, false, signature);
          assert.equal(row.authed, false, signature);
          assert.equal(row.pub, false, signature);
          assert.equal(row.service, true, signature);
        }
      });

      test('0652 redefines none of the activation, rollback, evidence or re-embed functions', () => {
        const sql = fs.readFileSync(MIGRATION, 'utf8');
        assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?(rag_activate_embedding_profile|rag_rollback_embedding_profile|rag_record_eval_evidence|rag_reembed_\w+|rag_set_embedding_profile_status)\b/i);
      });
    });
  });
}
