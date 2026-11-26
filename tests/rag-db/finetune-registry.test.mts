import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { allowListEntryFor } from '../helpers/security-definer-allow-list';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

const ORG_A = 'o:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'o:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SINGLE = 's:default';

const FUNCTIONS = [
  'public.rag_finetune_set_consent(text, text, text, text)',
  'public.rag_finetune_list_consent()',
  'public.rag_finetune_consent_for_export(text[], text)',
  'public.rag_finetune_register_model(jsonb, text)',
  'public.rag_finetune_list_models(boolean)',
  'public.rag_finetune_set_model_status(text, text, text)',
];
const TABLES = ['public.rag_finetune_consent', 'public.embedding_model_versions'];

function unitVector(axis: number): number[] {
  return Array.from({ length: 1024 }, (_, index) => (index === axis ? 1 : 0));
}

type Card = Record<string, unknown>;

function card(id: string, scope: 'deployment' | 'tenant', tenantKeys: string[], overrides: Card = {}): Card {
  return {
    id,
    base_model: 'example/base-embedding-model',
    base_revision: 'a'.repeat(40),
    dims: 1024,
    scope,
    tenant_keys: [...tenantKeys].sort(),
    dataset_manifest_sha256: 'b'.repeat(64),
    training_config_sha256: 'c'.repeat(64),
    query_prompt: 'query: ',
    document_prompt: 'passage: ',
    offline: { passed: true, noise_band: 0.01, reasons: [], models: { finetuned: { overall: { n: 12, recall_at_10: 0.8, mrr_at_10: 0.6, ndcg_at_10: 0.65 } } } },
    status: 'candidate',
    probe: {
      texts: ['first neutral probe sentence', 'second neutral probe sentence', 'third neutral probe sentence'],
      query_prompt: 'query: ',
      document_prompt: 'passage: ',
      vectors: [unitVector(0), unitVector(1), unitVector(2)],
    },
    artifact_uri: `s3://models-bucket/${id}`,
    ...overrides,
  };
}

async function inTransaction(db: PGlite, body: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await body();
  } finally {
    await db.exec('ROLLBACK');
  }
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

async function setConsent(db: PGlite, tenant: string, scope: string, ref: string | null = 'TICKET-1', actor: string | null = 'op') {
  const result = await db.query<{ tenant_key: string; scope: string; tainted_versions: string[] }>(
    'SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)',
    [tenant, scope, ref, actor],
  );
  return result.rows[0];
}

async function exportKeys(db: PGlite, keys: string[], purpose: string): Promise<string[]> {
  const result = await db.query<{ keys: string[] }>('SELECT public.rag_finetune_consent_for_export($1::text[], $2) AS keys', [keys, purpose]);
  return result.rows[0]?.keys ?? [];
}

async function register(db: PGlite, value: Card): Promise<string> {
  return outcome(db, 'SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', [JSON.stringify(value), 'op']);
}

async function statusOf(db: PGlite, id: string): Promise<string | undefined> {
  const result = await db.query<{ status: string }>('SELECT status FROM public.embedding_model_versions WHERE id = $1', [id]);
  return result.rows[0]?.status;
}

async function consentRow(db: PGlite, tenant: string) {
  const result = await db.query<Record<string, unknown>>('SELECT * FROM public.rag_finetune_consent WHERE tenant_key = $1', [tenant]);
  return result.rows[0];
}

/** Rows for a tenant that this deployment mode cannot name through the functions, written straight to the tables. */
async function seedForeignTenant(db: PGlite, tenant: string, versionId: string, tenantKeys: string[]): Promise<void> {
  await db.query(
    `INSERT INTO public.rag_finetune_consent (tenant_key, scope, evidence_ref, granted_by, granted_at, updated_at)
     VALUES ($1, 'deployment', 'TICKET-B', 'op', now(), now())`,
    [tenant],
  );
  await db.query(
    `INSERT INTO public.embedding_model_versions
       (id, base_model, base_revision, scope, tenant_keys, dataset_manifest_sha256, training_config_sha256, offline_metrics, probe,
        query_prompt, document_prompt, dims, artifact_uri, status, created_by)
     VALUES ($1, 'example/base-embedding-model', $2, 'deployment', $3::text[], $4, $4, '{}'::jsonb, '{}'::jsonb, '', '', 1024,
             's3://models-bucket/seed', 'registered', 'seed')`,
    [versionId, 'a'.repeat(40), tenantKeys, 'd'.repeat(64)],
  );
}

test('the six functions are service_role only: none is on the authenticated allow-list', () => {
  for (const signature of FUNCTIONS) {
    assert.equal(allowListEntryFor(signature), undefined, signature);
  }
});

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const A = multi ? ORG_A : SINGLE;

  describe(`0651 fine-tune consent and model registry (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS })).db;
    });

    after(async () => {
      await db?.close();
    });

    test('the tables and the six functions exist', async () => {
      for (const signature of FUNCTIONS) {
        const found = await db.query<{ oid: string | null }>('SELECT to_regprocedure($1)::text AS oid', [signature]);
        assert.notEqual(found.rows[0]?.oid ?? null, null, `${signature} is missing`);
      }
      for (const table of TABLES) {
        const found = await db.query<{ oid: string | null }>('SELECT to_regclass($1)::text AS oid', [table]);
        assert.notEqual(found.rows[0]?.oid ?? null, null, `${table} is missing`);
      }
    });

    test('RLS is on without policies and only service_role reaches the tables and functions', async () => {
      for (const table of TABLES) {
        const rls = await db.query<{ rls: boolean; policies: number }>(
          `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c WHERE c.oid = to_regclass($1)`,
          [table],
        );
        assert.deepEqual(rls.rows[0], { rls: true, policies: 0 }, table);
        const privileges = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r.role, has_table_privilege(r.role, $1, 'SELECT') OR has_table_privilege(r.role, $1, 'INSERT')
                  OR has_table_privilege(r.role, $1, 'UPDATE') OR has_table_privilege(r.role, $1, 'DELETE') AS allowed
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [table],
        );
        assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true }, table);
      }
      for (const signature of FUNCTIONS) {
        const meta = await db.query<{ definer: boolean; config: string[] | null; acl: string | null }>(
          'SELECT prosecdef AS definer, proconfig AS config, proacl::text AS acl FROM pg_proc WHERE oid = to_regprocedure($1)',
          [signature],
        );
        assert.equal(meta.rows[0]?.definer, true, `${signature} is SECURITY DEFINER`);
        assert.deepEqual(meta.rows[0]?.config, ['search_path=""'], `${signature} has an empty search_path`);
        assert.ok(!/(^|[{,])=X/.test(meta.rows[0]?.acl ?? ''), `${signature}: no PUBLIC execute`);
        const privileges = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, to_regprocedure($1), 'EXECUTE') AS allowed
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [signature],
        );
        assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true }, signature);
      }
    });

    test('SET ROLE anon and authenticated get 42501 on the tables and functions; service_role succeeds', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const sql of [
          'SELECT 1 FROM public.rag_finetune_consent',
          'SELECT 1 FROM public.embedding_model_versions',
          'SELECT * FROM public.rag_finetune_list_consent()',
          'SELECT * FROM public.rag_finetune_list_models(false)',
          `SELECT * FROM public.rag_finetune_set_consent('${A}', 'deployment', 'TICKET-1', 'op')`,
        ]) {
          await db.exec(`SET ROLE ${role}`);
          try {
            await assert.rejects(() => db.query(sql), (error: unknown) => (error as { code?: string }).code === '42501', `${role}: ${sql}`);
          } finally {
            await db.exec('RESET ROLE');
          }
        }
      }
      await inTransaction(db, async () => {
        await db.exec('SET LOCAL ROLE service_role');
        await setConsent(db, A, 'deployment');
        const listed = await db.query<{ tenant_key: string }>('SELECT tenant_key FROM public.rag_finetune_list_consent()');
        assert.deepEqual(listed.rows.map((row) => row.tenant_key), [A]);
      });
    });

    test('deployment consent covers a deployment export of that tenant', async () => {
      await inTransaction(db, async () => {
        const result = await setConsent(db, A, 'deployment');
        assert.deepEqual(result, { tenant_key: A, scope: 'deployment', tainted_versions: [] });
        assert.deepEqual(await exportKeys(db, [A], 'deployment'), [A]);
        assert.deepEqual(await exportKeys(db, [A], 'private'), [A]);
      });
    });

    test('no row means none: every export of an unknown tenant is refused', async () => {
      await inTransaction(db, async () => {
        assert.match(await outcome(db, 'SELECT public.rag_finetune_consent_for_export($1::text[], $2)', [[A], 'private']), new RegExp(`^consent_refused: .*${A}`));
        assert.match(await outcome(db, 'SELECT public.rag_finetune_consent_for_export($1::text[], $2)', [[A], 'deployment']), new RegExp(`^consent_refused: .*${A}`));
      });
    });

    test('an empty key list, a null key, a duplicate key and an unknown purpose are refused', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        const call = 'SELECT public.rag_finetune_consent_for_export($1::text[], $2)';
        assert.match(await outcome(db, call, [[], 'deployment']), /^consent_refused: tenant_keys_empty/);
        assert.match(await outcome(db, call, [null, 'deployment']), /^consent_refused: tenant_keys_empty/);
        assert.match(await outcome(db, call, [[A, null], 'deployment']), /^tenant_key_invalid/);
        assert.match(await outcome(db, call, [[A, A], 'deployment']), /^consent_refused: tenant_keys_duplicate/);
        assert.match(await outcome(db, call, [[A], 'everything']), /^consent_refused: purpose/);
        assert.match(await outcome(db, call, [[A], null]), /^consent_refused: purpose/);
      });
    });

    test('granting needs an evidence reference and an actor; malformed keys and scopes are refused', async () => {
      await inTransaction(db, async () => {
        const call = 'SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)';
        assert.match(await outcome(db, call, [A, 'deployment', '', 'op']), /^consent_refused: evidence_required/);
        assert.match(await outcome(db, call, [A, 'private', '   ', 'op']), /^consent_refused: evidence_required/);
        assert.match(await outcome(db, call, [A, 'private', null, 'op']), /^consent_refused: evidence_required/);
        assert.match(await outcome(db, call, [A, 'deployment', 'TICKET-1', '']), /^consent_refused: actor_required/);
        assert.match(await outcome(db, call, [A, 'deployment', 'TICKET-1', null]), /^consent_refused: actor_required/);
        assert.match(await outcome(db, call, [A, 'none', null, null]), /^consent_refused: actor_required/);
        assert.match(await outcome(db, call, [A, 'deployment', 'someone@example.com', 'op']), /^consent_refused: evidence_ref_invalid/);
        assert.match(await outcome(db, call, [A, 'deployment', 'x'.repeat(201), 'op']), /^consent_refused: evidence_ref_invalid/);
        assert.match(await outcome(db, call, [A, 'all', 'TICKET-1', 'op']), /^consent_refused: scope/);
        assert.match(await outcome(db, call, ['x', 'deployment', 'TICKET-1', 'op']), /^tenant_key_invalid/);
        assert.match(await outcome(db, call, [null, 'deployment', 'TICKET-1', 'op']), /^tenant_key_invalid/);
        assert.equal(await consentRow(db, A), undefined, 'no refused call wrote a row');
      });
    });

    test('the table refuses a malformed tenant key and a grant without evidence even for a direct write', async () => {
      await inTransaction(db, async () => {
        assert.notEqual(await outcome(db, "INSERT INTO public.rag_finetune_consent (tenant_key, scope, updated_at) VALUES ('x', 'none', now())"), 'accepted');
        assert.notEqual(
          await outcome(db, 'INSERT INTO public.rag_finetune_consent (tenant_key, scope, granted_by, granted_at, updated_at) VALUES ($1, $2, $3, now(), now())', [A, 'deployment', 'op']),
          'accepted',
        );
      });
    });

    test('revocation sets none and revoked_at; granting again clears revoked_at', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        const revoked = await setConsent(db, A, 'none', null, 'op');
        assert.equal(revoked?.scope, 'none');
        const row = await consentRow(db, A);
        assert.equal(row?.scope, 'none');
        assert.ok(row?.revoked_at instanceof Date);
        assert.equal(row?.revoked_by, 'op');
        assert.match(await outcome(db, 'SELECT public.rag_finetune_consent_for_export($1::text[], $2)', [[A], 'private']), /^consent_refused/);
        await setConsent(db, A, 'private', 'TICKET-2', 'op');
        const regranted = await consentRow(db, A);
        assert.equal(regranted?.scope, 'private');
        assert.equal(regranted?.revoked_at, null);
        assert.equal(regranted?.evidence_ref, 'TICKET-2');
      });
    });

    test('register refuses every card the registry must not hold', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        assert.equal(await register(db, card('ft-alpha-1', 'deployment', [A])), 'accepted');
        assert.equal(await statusOf(db, 'ft-alpha-1'), 'registered');
        assert.match(await register(db, card('ft-alpha-1', 'deployment', [A])), /^register_refused: duplicate/);
        assert.match(await register(db, card('ft-alpha-2', 'deployment', [A], { dims: 768 })), /^register_refused: dims/);
        assert.match(await register(db, card('ft-alpha-3', 'deployment', [A], { status: 'rejected_offline' })), /^register_refused: offline_gate/);
        assert.match(await register(db, card('ft-alpha-3', 'deployment', [A], { status: 'registered' })), /^register_refused: status/);
        for (const uri of ['s3://k:s@bucket/x', 's3://bucket/x?sig=1', 's3://bucket/x#frag', 'bucket/x', '']) {
          assert.match(await register(db, card('ft-alpha-4', 'deployment', [A], { artifact_uri: uri })), /^register_refused: artifact_uri/, uri);
        }
        assert.match(await register(db, card('Not-An-Id', 'deployment', [A])), /^register_refused: id/);
        assert.match(await register(db, card('ft-alpha-5', 'shared' as 'deployment', [A])), /^register_refused: scope/);
        assert.match(await register(db, card('ft-alpha-6', 'deployment', [])), /^register_refused: tenant_keys/);
        assert.match(await register(db, card('ft-alpha-6', 'deployment', ['x'])), /^register_refused: tenant_keys/);
        assert.match(await register(db, card('ft-alpha-7', 'deployment', [A], { base_revision: 'main' })), /^register_refused: base_revision/);
        assert.match(await register(db, card('ft-alpha-7', 'deployment', [A], { dataset_manifest_sha256: 'short' })), /^register_refused: hashes/);
        assert.match(await register(db, card('ft-alpha-8', 'deployment', [A], { probe: { texts: ['one'], vectors: [] } })), /^register_refused: probe/);
        const half = unitVector(0).map((value) => value / 2);
        const probe = card('x', 'deployment', [A]).probe as Card;
        assert.match(await register(db, card('ft-alpha-8', 'deployment', [A], { probe: { ...probe, vectors: [half, unitVector(1), unitVector(2)] } })), /^register_refused: probe/);
        assert.match(await register(db, card('ft-alpha-9', 'deployment', [A], { offline: { note: 'free text is not a metric' } })), /^register_refused: offline/);
        assert.match(await register(db, card('ft-alpha-9', 'deployment', [A], { query_prompt: 7 })), /^register_refused: prompts/);
        assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', [JSON.stringify(card('ft-alpha-10', 'deployment', [A])), '']), /^register_refused: actor/);
        assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_register_model($1::jsonb, $2)', ['[]', 'op']), /^register_refused: card/);
        const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.embedding_model_versions');
        assert.equal(count.rows[0]?.n, 1, 'only the valid card was stored');
      });
    });

    test('register stores numbers only from the offline report and never returns probe vectors unless asked', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'private');
        assert.equal(await register(db, card('ft-beta-1', 'tenant', [A])), 'accepted');
        const listed = await db.query<{ id: string; probe: unknown; tenant_keys: string[]; scope: string; offline_metrics: Record<string, unknown> }>(
          'SELECT * FROM public.rag_finetune_list_models()',
        );
        assert.equal(listed.rows.length, 1);
        assert.equal(listed.rows[0]?.probe, null);
        assert.deepEqual(listed.rows[0]?.tenant_keys, [A]);
        assert.equal(listed.rows[0]?.scope, 'tenant');
        assert.deepEqual(listed.rows[0]?.offline_metrics, card('x', 'tenant', [A]).offline);
        const withProbe = await db.query<{ probe: { vectors: number[][] } }>('SELECT probe FROM public.rag_finetune_list_models(true)');
        assert.equal(withProbe.rows[0]?.probe.vectors.length, 3);
        assert.equal(withProbe.rows[0]?.probe.vectors[0]?.length, 1024);
      });
    });

    test('status changes: registered to retired and anything to tainted; taint is final', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        await register(db, card('ft-gamma-1', 'deployment', [A]));
        await register(db, card('ft-gamma-2', 'deployment', [A]));
        const call = 'SELECT * FROM public.rag_finetune_set_model_status($1, $2, $3)';
        assert.equal(await outcome(db, call, ['ft-gamma-1', 'retired', 'op']), 'accepted');
        assert.equal(await statusOf(db, 'ft-gamma-1'), 'retired');
        assert.match(await outcome(db, call, ['ft-gamma-1', 'registered', 'op']), /^status_refused: transition/);
        assert.match(await outcome(db, call, ['ft-gamma-2', 'bound', 'op']), /^status_refused: transition/);
        assert.equal(await outcome(db, call, ['ft-gamma-2', 'tainted', 'op']), 'accepted');
        assert.equal(await statusOf(db, 'ft-gamma-2'), 'tainted');
        for (const next of ['registered', 'retired', 'bound']) {
          assert.match(await outcome(db, call, ['ft-gamma-2', next, 'op']), /^status_refused: tainted_final/);
        }
        assert.match(await outcome(db, call, ['ft-missing', 'retired', 'op']), /^status_refused: not_found/);
        assert.match(await outcome(db, call, ['ft-gamma-1', 'tainted', '']), /^status_refused: actor/);
      });
    });

    test('revoking a tenant taints every version trained on it, in the same call, and nothing else', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        await register(db, card('ft-delta-a', 'deployment', [A]));
        await register(db, card('ft-delta-private', 'tenant', [A]));
        const revoked = await setConsent(db, A, 'none', null, 'op');
        assert.deepEqual([...(revoked?.tainted_versions ?? [])].sort(), ['ft-delta-a', 'ft-delta-private']);
        assert.equal(await statusOf(db, 'ft-delta-a'), 'tainted');
        assert.equal(await statusOf(db, 'ft-delta-private'), 'tainted');
        const again = await setConsent(db, A, 'none', null, 'op');
        assert.deepEqual(again?.tainted_versions, [], 'already tainted versions are not reported twice');
      });
    });

    test('narrowing deployment consent to private taints the deployment-scope versions only', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        await register(db, card('ft-eps-shared', 'deployment', [A]));
        await register(db, card('ft-eps-private', 'tenant', [A]));
        const narrowed = await setConsent(db, A, 'private', 'TICKET-3', 'op');
        assert.deepEqual(narrowed?.tainted_versions, ['ft-eps-shared']);
        assert.equal(await statusOf(db, 'ft-eps-private'), 'registered');
      });
    });

    if (multi) {
      test('two tenants: export and register follow each tenant\'s own consent', async () => {
        await inTransaction(db, async () => {
          await setConsent(db, ORG_A, 'deployment');
          await setConsent(db, ORG_B, 'private', 'TICKET-B', 'op');
          assert.deepEqual(await exportKeys(db, [ORG_B], 'private'), [ORG_B]);
          const call = 'SELECT public.rag_finetune_consent_for_export($1::text[], $2)';
          assert.match(await outcome(db, call, [[ORG_A, ORG_B], 'deployment']), new RegExp(`^consent_refused: .*${ORG_B}`));
          assert.doesNotMatch(await outcome(db, call, [[ORG_A, ORG_B], 'deployment']), new RegExp(ORG_A));
          assert.match(await outcome(db, call, [[ORG_A, ORG_B], 'private']), /^consent_refused: private_takes_one_tenant/);
          assert.equal(await register(db, card('ft-b-private', 'tenant', [ORG_B])), 'accepted');
          assert.match(await register(db, card('ft-b-shared', 'deployment', [ORG_B])), new RegExp(`^register_refused: consent .*${ORG_B}`));
          assert.match(await register(db, card('ft-ab-tenant', 'tenant', [ORG_A, ORG_B])), /^register_refused: tenant_scope_single/);
          assert.match(await register(db, card('ft-ab-shared', 'deployment', [ORG_A, ORG_B])), new RegExp(`^register_refused: consent .*${ORG_B}`));
          const unknown = 'o:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
          assert.match(await register(db, card('ft-c-private', 'tenant', [unknown])), new RegExp(`^register_refused: consent .*${unknown}`));
        });
      });

      test('two tenants: consent and revocation for A never change B\'s consent or B\'s versions; a joint version is tainted by either', async () => {
        for (const revoke of [ORG_A, ORG_B]) {
          await inTransaction(db, async () => {
            await setConsent(db, ORG_A, 'deployment');
            await setConsent(db, ORG_B, 'deployment', 'TICKET-B', 'op');
            assert.equal(await register(db, card('ft-v1-ab', 'deployment', [ORG_A, ORG_B])), 'accepted');
            assert.equal(await register(db, card('ft-v2-b', 'deployment', [ORG_B])), 'accepted');
            assert.equal(await register(db, card('ft-v3-a', 'tenant', [ORG_A])), 'accepted');
            const other = revoke === ORG_A ? ORG_B : ORG_A;
            const before = await consentRow(db, other);
            const result = await setConsent(db, revoke, 'none', null, 'op');
            assert.deepEqual(await consentRow(db, other), before, `${other}'s consent row is unchanged`);
            assert.equal(await statusOf(db, 'ft-v1-ab'), 'tainted');
            if (revoke === ORG_A) {
              assert.deepEqual([...(result?.tainted_versions ?? [])].sort(), ['ft-v1-ab', 'ft-v3-a']);
              assert.equal(await statusOf(db, 'ft-v2-b'), 'registered');
            } else {
              assert.deepEqual([...(result?.tainted_versions ?? [])].sort(), ['ft-v1-ab', 'ft-v2-b']);
              assert.equal(await statusOf(db, 'ft-v3-a'), 'registered');
            }
          });
        }
      });

      test('a single-tenant key is refused in multi-tenant mode', async () => {
        await inTransaction(db, async () => {
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [SINGLE, 'deployment', 'TICKET-1', 'op']), /^tenant_key_invalid/);
        });
      });
    } else {
      test('a multi-tenant key is refused in single-tenant mode, by consent, export and register', async () => {
        await inTransaction(db, async () => {
          await setConsent(db, SINGLE, 'deployment');
          assert.match(await outcome(db, 'SELECT * FROM public.rag_finetune_set_consent($1, $2, $3, $4)', [ORG_B, 'deployment', 'TICKET-1', 'op']), /^tenant_key_invalid/);
          assert.match(await outcome(db, 'SELECT public.rag_finetune_consent_for_export($1::text[], $2)', [[SINGLE, ORG_B], 'deployment']), /^tenant_key_invalid/);
          assert.match(await register(db, card('ft-foreign', 'deployment', [SINGLE, ORG_B])), /^register_refused: tenant_keys/);
        });
      });

      test('revoking s:default never changes rows of another tenant written straight to the tables', async () => {
        await inTransaction(db, async () => {
          await setConsent(db, SINGLE, 'deployment');
          await seedForeignTenant(db, ORG_B, 'ft-seed-b', [ORG_B]);
          await db.query(
            `INSERT INTO public.embedding_model_versions
               (id, base_model, base_revision, scope, tenant_keys, dataset_manifest_sha256, training_config_sha256, offline_metrics, probe,
                query_prompt, document_prompt, dims, artifact_uri, status, created_by)
             SELECT 'ft-seed-joint', base_model, base_revision, scope, ARRAY[$1, $2]::text[], dataset_manifest_sha256, training_config_sha256,
                    offline_metrics, probe, query_prompt, document_prompt, dims, artifact_uri, status, created_by
             FROM public.embedding_model_versions WHERE id = 'ft-seed-b'`,
            [SINGLE, ORG_B],
          );
          const before = await consentRow(db, ORG_B);
          const result = await setConsent(db, SINGLE, 'none', null, 'op');
          assert.deepEqual(result?.tainted_versions, ['ft-seed-joint']);
          assert.deepEqual(await consentRow(db, ORG_B), before);
          assert.equal(await statusOf(db, 'ft-seed-b'), 'registered');
        });
      });
    }

    test('the migration applies a second time without changing the rows', async () => {
      await inTransaction(db, async () => {
        await setConsent(db, A, 'deployment');
        await register(db, card('ft-idem-1', 'deployment', [A]));
        const fs = await import('node:fs');
        const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0651_finetune_registry.sql'), 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
        await db.exec(sql);
        assert.equal(await statusOf(db, 'ft-idem-1'), 'registered');
        assert.equal((await consentRow(db, A))?.scope, 'deployment');
      });
    });
  });
}
