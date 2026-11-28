import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { DeploymentMode, FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { ACTOR, LEGACY_EMBEDDING, createFixture, decision, helpers, vector, type Tenant } from '../helpers/chunking-profile-fixture.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const FUNCTIONS = [
  'rag_create_chunking_profile(text,text,integer,text,integer,text)',
  'rag_record_chunking_decision(text,jsonb)',
  'rag_activate_chunking_profile(text,text,text)',
  'rag_rollback_chunking_profile(text,text)',
  'rag_chunking_coverage()',
  'rag_chunking_profile_state()',
];

for (const mode of MODES) {
  describe(`chunking activation gates and rollback (${mode})`, () => {
    let fixture: FixtureDatabase;
    let a: Tenant;
    let b: Tenant | null;
    let h: ReturnType<typeof helpers>;
    const contracts: Array<{ id: string; tenant: Tenant; name: string }> = [];
    let generalId = '';
    const technical: Array<{ id: string; tenant: Tenant; name: string }> = [];

    before(async () => {
      ({ fixture, a, b } = await createFixture(mode));
      h = helpers(fixture, mode);
      for (const [name, tenant] of [['contract-a1', a], ['contract-a2', a], ...(b ? [['contract-b1', b]] : [])] as Array<[string, Tenant]>) {
        contracts.push({ id: await h.seed(tenant, name, 'contract_legal'), tenant, name });
      }
      generalId = await h.seed(a, 'general-a1', 'general');
      for (const name of ['tech-a1', 'tech-a2']) technical.push({ id: await h.seed(a, name, 'product_technical'), tenant: a, name });
    });

    after(async () => {
      await fixture?.db.close();
    });

    test('the five functions exist, are invoker functions with an empty search_path, and only service_role may execute them', async () => {
      for (const signature of FUNCTIONS) {
        const rows = await h.query(
          `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                  COALESCE((SELECT bool_or(g.grantee = 0) FROM aclexplode(p.proacl) g WHERE g.privilege_type = 'EXECUTE'), true) AS public_exec,
                  p.prosecdef AS definer,
                  COALESCE((SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), '') AS search_path
           FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [signature],
        );
        assert.ok(rows[0], `${signature} does not exist`);
        assert.deepEqual(
          { ...rows[0], search_path: String(rows[0]?.search_path).replace(/\s/g, '') },
          { anon: false, authenticated: false, service_role: true, public_exec: false, definer: false, search_path: 'search_path=""' },
          signature,
        );
      }
      for (const role of ['anon', 'authenticated']) {
        await fixture.db.exec(`SET ROLE ${role}`);
        try {
          for (const sql of [
            `SELECT * FROM rag_create_chunking_profile('x-probe', 'general', 256, 'structure', 1024, '256/1024')`,
            `SELECT * FROM rag_record_chunking_decision('x-probe', '{}'::jsonb)`,
            `SELECT * FROM rag_activate_chunking_profile('legacy', NULL, 'general')`,
            `SELECT * FROM rag_rollback_chunking_profile('general', NULL)`,
            'SELECT * FROM rag_chunking_coverage()',
            'SELECT * FROM rag_chunking_profile_state()',
          ]) {
            const error = await h.errorOf(sql);
            assert.equal(error?.code, '42501', `${role} ran ${sql}: ${error?.message ?? 'no error'}`);
          }
        } finally {
          await fixture.db.exec('RESET ROLE');
        }
      }
    });

    test('create inserts a building profile; a reserved, upper-case or unknown-type id and a parent below twice the child raise 22023 and write nothing', async () => {
      const created = await h.create('p256-1024', 'contract_legal');
      assert.equal(created[0]?.profile_id, 'p256-1024');
      const row = await h.profileRow('p256-1024', 'contract_legal');
      assert.deepEqual(
        { status: row?.status, child: row?.child_tokens, parent: row?.parent_tokens, mode: row?.parent_mode, preset: row?.preset },
        { status: 'building', child: 256, parent: 1024, mode: 'structure', preset: '256/1024' },
      );
      const before = Number((await h.query('SELECT count(*)::int AS n FROM chunking_profiles'))[0]?.n);
      const bad: Array<[string, unknown[]]> = [
        ['legacy', ['legacy', 'general', 256, 'structure', 1024, '256/1024']],
        ['upper-case id', ['P256', 'general', 256, 'structure', 1024, '256/1024']],
        ['unknown doc type', ['x-unknown', 'memo', 256, 'structure', 1024, '256/1024']],
        ['parent 400 under child 256', ['x-small-parent', 'general', 256, 'fixed', 400, 'custom']],
        ['fixed without parent', ['x-no-parent', 'general', 256, 'fixed', null, 'custom']],
        ['zero child', ['x-zero', 'general', 0, 'none', null, 'custom']],
        ['unknown preset', ['x-preset', 'general', 256, 'structure', 1024, '999/9999']],
        ['unknown parent mode', ['x-mode', 'general', 256, 'sliding', 1024, 'custom']],
      ];
      for (const [name, params] of bad) {
        const error = await h.errorOf('SELECT * FROM rag_create_chunking_profile($1, $2, $3, $4, $5, $6)', params);
        assert.equal(error?.code, '22023', `${name}: ${error?.message ?? 'no error'}`);
      }
      assert.equal(Number((await h.query('SELECT count(*)::int AS n FROM chunking_profiles'))[0]?.n), before, 'a refused create wrote a row');
    });

    test('record-decision stores a decision whose doc type and profile id match the row, and refuses the rest', async () => {
      await h.create('rec-1', 'general');
      const mismatches: Array<[string, string, unknown]> = [
        ['another profile id', 'rec-1', decision('rec-2', 'general')],
        ['another doc type', 'rec-1', decision('rec-1', 'contract_legal')],
        ['gate_passed not a boolean', 'rec-1', decision('rec-1', 'general', { gate_passed: 'yes' })],
        ['gate_passed missing', 'rec-1', (({ gate_passed: _gate, ...rest }) => rest)(decision('rec-1', 'general'))],
        ['not an object', 'rec-1', ['array']],
        ['unknown profile', 'rec-none', decision('rec-none', 'general')],
        ['legacy', 'legacy', decision('legacy', 'general')],
      ];
      for (const [name, profileId, payload] of mismatches) {
        const error = await h.errorOf('SELECT * FROM rag_record_chunking_decision($1, $2::jsonb)', [profileId, JSON.stringify(payload)]);
        assert.ok(error, `${name} was accepted`);
        assert.equal((await h.profileRow('rec-1', 'general'))?.eval_evidence, null, `${name} left evidence behind`);
      }
      const stored = decision('rec-1', 'general', { chosen_on: { recall_at_k: 0.77 } });
      const result = await h.record('rec-1', stored);
      assert.equal(result[0]?.profile_id, 'rec-1');
      assert.deepEqual((await h.profileRow('rec-1', 'general'))?.eval_evidence, stored);
    });

    test('activate refuses in order with a stable prefix, then flips the pointer in one step', async () => {
      const refused = async (id: string, docType: string, reason: string): Promise<void> => {
        const error = await h.activateError(id, docType);
        assert.ok(error, `activation of ${id} succeeded, expected ${reason}`);
        assert.match(error.message, new RegExp(`chunking_activation_refused:${reason}\\b`), `${id}: ${error.message}`);
        assert.equal((await h.profileRow('legacy', docType))?.status, 'active', `a refused activation moved the pointer (${reason})`);
      };
      const docType = 'product_technical';
      await refused('no-such-profile', docType, 'unknown_profile');

      await h.create('gate-1', docType);
      await refused('gate-1', docType, 'not_ready');
      await fixture.db.exec(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'gate-1' AND doc_type = '${docType}'`);

      const first = technical[0] as (typeof technical)[number];
      const second = technical[1] as (typeof technical)[number];
      await h.fill(first.id, first.tenant, 'gate-1', first.name);
      await refused('gate-1', docType, 'incomplete');
      await h.fill(second.id, second.tenant, 'gate-1', second.name);

      const earlier = crypto.randomUUID();
      await fixture.db.query(
        `INSERT INTO chunking_build_runs (id, profile_id, doc_type, status, started_at) VALUES ($1, 'gate-1', $2, 'incomplete', now() - interval '2 hours')`,
        [earlier, docType],
      );
      await fixture.db.query(`INSERT INTO chunking_build_gaps (run_id, document_id, reason) VALUES ($1, $2, 'failed')`, [earlier, first.id]);
      await refused('gate-1', docType, 'open_gaps');

      const completed = crypto.randomUUID();
      await fixture.db.query(
        `INSERT INTO chunking_build_runs (id, profile_id, doc_type, status, started_at) VALUES ($1, 'gate-1', $2, 'completed', now() - interval '1 hour')`,
        [completed, docType],
      );
      await refused('gate-1', docType, 'no_evidence');

      await h.record('gate-1', decision('gate-1', docType, { gate_passed: false, build_run_id: completed }));
      await refused('gate-1', docType, 'eval_failed');

      await h.record('gate-1', decision('gate-1', docType, { build_run_id: crypto.randomUUID() }));
      await refused('gate-1', docType, 'stale_evidence');
      await h.record('gate-1', decision('gate-1', docType, { build_run_id: null }));
      await refused('gate-1', docType, 'stale_evidence');

      await h.record('gate-1', decision('gate-1', docType, { build_run_id: completed }));
      const done = await h.activate('gate-1', docType);
      assert.equal(done[0]?.activated_profile, 'gate-1');
      assert.equal(done[0]?.previous_profile, 'legacy');
      const row = await h.profileRow('gate-1', docType);
      assert.equal(row?.status, 'active');
      assert.equal(row?.previous_active_id, 'legacy');
      assert.equal(row?.activated_by, ACTOR);
      assert.ok(row?.activated_at, 'activated_at is recorded');
      assert.equal((await h.profileRow('legacy', docType))?.status, 'ready');
      const active = await h.query(`SELECT count(*)::int AS n FROM chunking_profiles WHERE doc_type = $1 AND status = 'active'`, [docType]);
      assert.equal(active[0]?.n, 1, 'exactly one active profile per doc type');
      const listed = await h.query('SELECT id FROM rag_list_chunking_profiles() WHERE doc_type = $1 AND is_active', [docType]);
      assert.deepEqual(listed.map((r) => r.id), ['gate-1']);
      const other = await h.query(`SELECT count(*)::int AS n FROM chunking_profiles WHERE doc_type = 'contract_legal' AND status = 'active'`);
      assert.equal(other[0]?.n, 1);
      assert.equal((await h.profileRow('legacy', 'contract_legal'))?.status, 'active', 'another doc type was not touched');

      const again = await h.activate('gate-1', docType);
      assert.equal(again[0]?.changed, false, 'activating the active profile is a no-op');
      assert.equal((await h.profileRow('gate-1', docType))?.previous_active_id, 'legacy');

      await h.rollback(docType);
    });

    test('two null build run ids match: a profile filled only by ingestion dual-write activates with a null-run decision', async () => {
      const docType = 'product_technical';
      await h.create('gate-null', docType);
      await fixture.db.exec(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'gate-null' AND doc_type = '${docType}'`);
      for (const doc of technical) await h.fill(doc.id, doc.tenant, 'gate-null', doc.name);
      await h.record('gate-null', decision('gate-null', docType, { build_run_id: null }));
      const done = await h.activate('gate-null', docType);
      assert.equal(done[0]?.activated_profile, 'gate-null');
      await h.rollback(docType);
    });

    test('a profile id used by two doc types needs the doc type; legacy needs it too', async () => {
      await h.create('shared-id', 'general');
      await h.create('shared-id', 'financial_report');
      const error = await h.activateError('shared-id', null);
      assert.match(error?.message ?? 'no error', /chunking_activation_refused:ambiguous_profile\b/);
      const legacy = await h.activateError('legacy', null);
      assert.match(legacy?.message ?? 'no error', /chunking_activation_refused:ambiguous_profile\b/);
      const notReady = await h.activateError('shared-id', 'general');
      assert.match(notReady?.message ?? 'no error', /chunking_activation_refused:not_ready\b/);
    });

    test('activation and rollback follow retrieval: children after the flip, legacy rows after the rollback, legacy RPCs unchanged, tenants isolated', async () => {
      const docType = 'contract_legal';
      const rolledBackFirst = await h.errorOf('SELECT * FROM rag_rollback_chunking_profile($1, $2)', [docType, ACTOR]);
      assert.match(rolledBackFirst?.message ?? 'no error', /chunking_activation_refused:no_previous\b/, 'rollback while legacy is active');

      await fixture.db.exec(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'p256-1024' AND doc_type = '${docType}'`);
      for (const doc of contracts) await h.fill(doc.id, doc.tenant, 'p256-1024', doc.name);
      await h.record('p256-1024', decision('p256-1024', docType));

      const legacyIds = async (docId: string) => (await h.query(`SELECT id::text FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'legacy'`, [docId])).map((r) => String(r.id));
      const childIds = async (docId: string) => (await h.query(`SELECT id::text FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = 'p256-1024'`, [docId])).map((r) => String(r.id));

      const search = async (tenant: Tenant): Promise<Array<{ id: string; profile: string; documentId: string }>> =>
        (
          await h.query(
            `SELECT hs.chunk_id::text AS id, c.chunking_profile_id AS profile, c.document_id::text AS document_id
             FROM hybrid_search_chunks(
               p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
               p_dense_limit => 0, p_lexical_limit => 50) hs
             JOIN document_chunks c ON c.id = hs.chunk_id`,
            [tenant.key, LEGACY_EMBEDDING, `[${vector(1536, 0).join(',')}]`, ['indemnity']],
          )
        ).map((r) => ({ id: String(r.id), profile: String(r.profile), documentId: String(r.document_id) }));

      const legacyRpc = async (): Promise<string[]> => {
        const sql =
          mode === 'single-tenant'
            ? 'SELECT chunk_id::text AS id FROM match_document_chunks(query_embedding => $1::vector, similarity_threshold => 0.0, match_count => 200)'
            : 'SELECT id::text FROM match_documents_by_workspace(p_query_embedding => $1::vector, p_match_count => 200, p_min_similarity => 0.0, p_org_id => NULL, p_user_id => $2::uuid)';
        const flat = `[${Array.from({ length: 1536 }, () => 1).join(',')}]`;
        const params = mode === 'single-tenant' ? [flat] : [flat, a.userId];
        return (await h.query(sql, params)).map((r) => String(r.id)).sort();
      };

      const baselineRpc = await legacyRpc();
      assert.ok(baselineRpc.length > 0, 'the legacy RPC sees the fixture rows');
      const before = await search(a);
      assert.ok(before.length > 0 && before.every((hit) => hit.profile === 'legacy'), 'before activation only legacy rows are returned');

      const done = await h.activate('p256-1024', docType);
      assert.equal(done[0]?.activated_profile, 'p256-1024');
      assert.deepEqual(await legacyRpc(), baselineRpc, 'a legacy RPC changed after activation');

      const ownContracts = contracts.filter((doc) => doc.tenant.key === a.key);
      const after = await search(a);
      const afterByDoc = new Map<string, string[]>();
      for (const hit of after) afterByDoc.set(hit.documentId, [...(afterByDoc.get(hit.documentId) ?? []), `${hit.profile}:${hit.id}`]);
      for (const doc of ownContracts) {
        const hits = after.filter((hit) => hit.documentId === doc.id);
        assert.ok(hits.length > 0, `${doc.name} returned nothing after activation`);
        assert.ok(hits.every((hit) => hit.profile === 'p256-1024'), `${doc.name} still returned legacy rows after activation`);
        const stored = new Set(await childIds(doc.id));
        assert.ok(hits.every((hit) => stored.has(hit.id)));
      }
      const general = after.filter((hit) => hit.documentId === generalId);
      assert.ok(general.length > 0 && general.every((hit) => hit.profile === 'legacy'), 'other doc types keep serving legacy rows');
      const ownIds = new Set((await h.query('SELECT id::text FROM document_chunks WHERE tenant_key = $1', [a.key])).map((r) => String(r.id)));
      assert.ok(after.every((hit) => ownIds.has(hit.id)), 'tenant A received a row of another tenant');
      if (b) {
        const bContract = contracts.find((doc) => doc.tenant.key === b?.key) as (typeof contracts)[number];
        const bHits = await search(b);
        assert.ok(bHits.length > 0 && bHits.every((hit) => hit.documentId === bContract.id && hit.profile === 'p256-1024'), 'tenant B sees only its own children');
        assert.ok(after.every((hit) => hit.documentId !== bContract.id), 'tenant A received a row of tenant B');
      }

      const rolledBack = await h.rollback(docType);
      assert.equal(rolledBack[0]?.restored_profile, 'legacy');
      assert.equal(rolledBack[0]?.rolled_back_profile, 'p256-1024');
      assert.equal((await h.profileRow('p256-1024', docType))?.status, 'ready');
      assert.equal((await h.profileRow('legacy', docType))?.status, 'active');
      for (const doc of contracts) assert.equal((await childIds(doc.id)).length, 2, 'rollback removed children');
      assert.deepEqual(await legacyRpc(), baselineRpc, 'a legacy RPC changed after rollback');
      const restored = await search(a);
      assert.ok(restored.length > 0 && restored.every((hit) => hit.profile === 'legacy'), 'after the rollback only legacy rows are returned');
      for (const doc of ownContracts) {
        const expected = await legacyIds(doc.id);
        assert.ok(restored.some((hit) => expected.includes(hit.id)), `${doc.name} lost its legacy rows after rollback`);
      }

      const again = await h.activate('p256-1024', docType);
      assert.equal(again[0]?.activated_profile, 'p256-1024');
      const direct = await h.activate('legacy', docType);
      assert.equal(direct[0]?.activated_profile, 'legacy', 'activating legacy needs no evidence');
      assert.equal((await h.profileRow('p256-1024', docType))?.status, 'ready');
      assert.match((await h.errorOf('SELECT * FROM rag_rollback_chunking_profile($1, $2)', [docType, ACTOR]))?.message ?? 'no error', /no_previous/);
    });

    test('actor must be a uuid when given; a missing actor is recorded as a command-line action', async () => {
      const error = await h.errorOf(`SELECT * FROM rag_activate_chunking_profile('legacy', 'not-a-uuid', 'general')`);
      assert.equal(error?.code, '22023');
      const docType = 'product_technical';
      await h.create('gate-cli', docType);
      await fixture.db.exec(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'gate-cli' AND doc_type = '${docType}'`);
      for (const doc of technical) await h.fill(doc.id, doc.tenant, 'gate-cli', doc.name);
      await h.record('gate-cli', decision('gate-cli', docType));
      await h.activate('gate-cli', docType, null);
      assert.equal((await h.profileRow('gate-cli', docType))?.activated_by, 'cli');
      await h.rollback(docType, null);
      assert.equal((await h.profileRow('legacy', docType))?.activated_by, 'cli');
    });
  });

  describe(`rag_chunking_coverage counts documents missing from each profile (${mode})`, () => {
    let fixture: FixtureDatabase;
    let a: Tenant;
    let b: Tenant | null;
    let h: ReturnType<typeof helpers>;

    before(async () => {
      ({ fixture, a, b } = await createFixture(mode));
      h = helpers(fixture, `cov-${mode}`);
    });

    after(async () => {
      await fixture?.db.close();
    });

    test('rag_chunking_coverage counts documents missing from each profile', async () => {
      const docType = 'contract_legal';
      const withChildren: Array<[string, Tenant]> = [['cov-1', a], ['cov-2', b ?? a]];
      await h.create('p256-1024', docType);
      await fixture.db.exec(`UPDATE chunking_profiles SET status = 'ready' WHERE id = 'p256-1024' AND doc_type = '${docType}'`);
      for (const [name, tenant] of withChildren) {
        const id = await h.seed(tenant, name, docType);
        await h.fill(id, tenant, 'p256-1024', name);
      }
      await h.record('p256-1024', decision('p256-1024', docType));
      await h.activate('p256-1024', docType);

      const onlyLegacy = await h.seed(a, 'cov-3-legacy-only', docType);
      const oldVersion = await h.seed(a, 'cov-4', docType, { sourceKey: 'cov-4.md' });
      await h.seed(a, 'cov-4', docType, { sourceKey: 'cov-4.md' });
      await h.fill(oldVersion, a, 'p256-1024', 'cov-4-v1');
      await h.seed(a, 'cov-5-processing', docType, { publish: false });
      const general = await h.seed(a, 'cov-6-general', 'general');
      assert.ok(onlyLegacy && general);

      const rows = await h.query('SELECT * FROM rag_chunking_coverage() ORDER BY doc_type, profile_id');
      assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ['current_ready_documents', 'doc_type', 'documents_with_children', 'is_active', 'missing_documents', 'profile_id']);
      const contract = rows.find((row) => row.doc_type === docType && row.profile_id === 'p256-1024');
      assert.deepEqual(
        { ready: contract?.current_ready_documents, with: contract?.documents_with_children, missing: contract?.missing_documents, active: contract?.is_active },
        { ready: 4, with: 2, missing: 2, active: true },
        'p256-1024 counts the current ready contracts: cov-1, cov-2, cov-3 (legacy only) and cov-4 v2 (v1 is superseded)',
      );
      const legacy = rows.find((row) => row.doc_type === docType && row.profile_id === 'legacy');
      assert.deepEqual({ missing: legacy?.missing_documents, active: legacy?.is_active }, { missing: 0, active: false });
      const generalLegacy = rows.find((row) => row.doc_type === 'general' && row.profile_id === 'legacy');
      const generalReady = (await h.query(`SELECT count(*)::int AS n FROM documents WHERE doc_type = 'general' AND is_current AND status = 'ready'`))[0]?.n;
      assert.ok(Number(generalReady) >= 1);
      assert.deepEqual(
        { ready: generalLegacy?.current_ready_documents, missing: generalLegacy?.missing_documents, active: generalLegacy?.is_active },
        { ready: generalReady, missing: 0, active: true },
      );

      await h.fill(onlyLegacy, a, 'p256-1024', 'cov-3');
      const newest = String((await h.query(`SELECT id::text FROM documents WHERE source_key = 'cov-4.md' AND is_current`))[0]?.id);
      await h.fill(newest, a, 'p256-1024', 'cov-4-v2');
      const filled = (await h.query('SELECT missing_documents FROM rag_chunking_coverage() WHERE doc_type = $1 AND profile_id = $2', [docType, 'p256-1024']))[0];
      assert.equal(filled?.missing_documents, 0);
    });
  });
}
