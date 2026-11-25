import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = 'openai-3-small-1536';
const LAW = 'voyage-law-2-1024';
const LAW_MODEL = 'voyage-law-2';
const DOMAIN = 'voyage-4-large-1024-domain';
const CONTRACT = 'contract_legal';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const KEY_SHAPED = /sk-[A-Za-z0-9]|service-role|apikey|eyJ[A-Za-z0-9_-]{10,}/i;

type Row = Record<string, unknown>;

describe('rag:embedding argument parsing for binding commands', () => {
  let cli: typeof import('@/lib/rag/embeddings/cli');

  before(async () => {
    cli = await import('@/lib/rag/embeddings/cli');
  });

  test('bind parses a doc type, a profile and an optional tenant key', () => {
    assert.deepEqual(cli.parseEmbeddingArgs(['bind', CONTRACT, 'voyage-law-2-1024', '--tenant', `o:${TWO_TENANT_IDS.orgO}`]), {
      ok: true,
      command: 'bind',
      docType: CONTRACT,
      profileId: LAW,
      tenantKey: `o:${TWO_TENANT_IDS.orgO}`,
    });
    assert.deepEqual(cli.parseEmbeddingArgs(['bind', CONTRACT, LAW]), { ok: true, command: 'bind', docType: CONTRACT, profileId: LAW, tenantKey: null });
  });

  test('wrong arguments are refused before any database call', () => {
    const error = (argv: string[]): string => {
      const parsed = cli.parseEmbeddingArgs(argv);
      assert.equal(parsed.ok, false, argv.join(' '));
      return parsed.ok ? '' : parsed.error;
    };
    assert.match(error(['bind', 'memo', 'x']), /unknown doc type/);
    assert.match(error(['bind', CONTRACT, LAW, '--tenant', 'o:not-a-uuid']), /tenant/);
    assert.match(error(['activate-binding', 'not-a-uuid']), /binding id/);
    assert.match(error(['bind-status', crypto.randomUUID(), 'active']), /only activate-binding sets active/);
    assert.match(error(['bind-status', crypto.randomUUID(), 'paused']), /available, backfilling or retired/);
    assert.match(error(['record-binding-evidence', 'comparison.json']), /--binding/);
    assert.match(error(['rollback-binding']), /doc type/);
    assert.match(error(['deactivate-binding', 'memo']), /unknown doc type/);
    assert.match(error(['bindings', 'extra']), /no arguments/);
  });

  test('an argument error exits 2 and prints the usage', async () => {
    const lines: string[] = [];
    const code = await cli.main(['bind', 'memo', 'x'], { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /activate-binding <bindingId>/);
  });
});

describe('rag:embedding binding lifecycle against the fixture database', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let cli: typeof import('@/lib/rag/embeddings/cli');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let bindings: typeof import('@/lib/rag/embeddings/bindings');
  let tmp: string;
  let chunkIds: string[];

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    cli = await import('@/lib/rag/embeddings/cli');
    ingestDeps = await import('@/lib/rag/ingest/deps');
    ingestConfig = await import('@/lib/rag/ingest/config');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    bindings = await import('@/lib/rag/embeddings/bindings');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-cli-'));

    const documentId = crypto.randomUUID();
    await fixture.db.query('INSERT INTO documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
      documentId,
      'binding-sample.md',
      'A neutral synthetic paragraph about a sample record.',
      '{}',
      TWO_TENANT_IDS.userA,
      CONTRACT,
    ]);
    chunkIds = [];
    for (let index = 0; index < 3; index += 1) {
      const chunkId = crypto.randomUUID();
      await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
        chunkId,
        documentId,
        `A neutral synthetic sentence number ${index}.`,
        index,
        '{}',
      ]);
      chunkIds.push(chunkId);
    }
  });

  after(async () => {
    ingestDeps?.resetIngestDepsForTests();
    activeProfile?.resetActiveProfileForTests();
    bindings?.resetBindingsForTests();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    await edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  function useSwitches(domain: 'on' | 'off'): void {
    ingestConfig.resetIngestConfigForTests();
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: domain }) });
    activeProfile.resetActiveProfileForTests();
    bindings.resetBindingsForTests();
  }

  beforeEach(async () => {
    await fixture.db.query('DELETE FROM embedding_profile_bindings');
    await fixture.db.query('DELETE FROM embedding_backfill_gaps');
    await fixture.db.query('DELETE FROM embedding_backfill_runs');
    await fixture.db.query('DELETE FROM chunk_embeddings');
    useSwitches('on');
  });

  afterEach(() => {
    ingestDeps.resetIngestDepsForTests();
    activeProfile.resetActiveProfileForTests();
    bindings.resetBindingsForTests();
  });

  async function run(...argv: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await cli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    const text = lines.join('\n');
    assert.ok(!KEY_SHAPED.test(text), `no key-shaped string in the output: ${text}`);
    assert.ok(!/neutral synthetic/.test(text), `no chunk text in the output: ${text}`);
    return { code, text };
  }

  async function bindingId(docType: string, profileId: string, tenantKey: string | null = null): Promise<string> {
    const found = await rows(
      'SELECT id FROM embedding_profile_bindings WHERE doc_type = $1 AND profile_id = $2 AND COALESCE(tenant_key, \'\') = COALESCE($3, \'\')',
      [docType, profileId, tenantKey],
    );
    assert.equal(found.length, 1, 'the binding row exists');
    return String(found[0]!.id);
  }

  async function seedVectorsAndRun(profileId: string, model: string): Promise<string> {
    const inScope = await rows(
      `SELECT c.id FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = $1`,
      [CONTRACT],
    );
    assert.ok(chunkIds.every((id) => inScope.some((row) => row.id === id)), 'the test chunks are in scope');
    for (const { id: chunkId } of inScope) {
      await fixture.db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
         SELECT c.id, $2, c.tenant_key, array_fill(0.1::float4, ARRAY[1024])::halfvec, $3, 1024, now() - interval '2 hours'
         FROM document_chunks c WHERE c.id = $1`,
        [chunkId, profileId, model],
      );
    }
    const run = await rows("INSERT INTO embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, NULL, 'completed') RETURNING id", [profileId]);
    return String(run[0]!.id);
  }

  function comparisonFile(runId: string, provenance: Record<string, number>): string {
    const samples = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/contracts/samples.json'), 'utf8')) as {
      samples: Record<string, Record<string, unknown>>;
    };
    const comparison = structuredClone(samples.samples.BindingComparison!) as Record<string, unknown> & { baseline: Row; control: Row };
    comparison.doc_type = CONTRACT;
    comparison.baseline.profile_id = LEGACY;
    comparison.control.profile_id = LEGACY;
    comparison.provenance_counts = provenance;
    comparison.reembed_run_ids = { [LAW]: runId };
    comparison.fixture_embedder = false;
    const file = path.join(tmp, `comparison-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(comparison));
    return file;
  }

  test('the whole lifecycle: bind, stage, record evidence, refused on 3 real items, activated on 30, rolled back and deactivated', async () => {
    const bound = await run('bind', CONTRACT, LAW);
    assert.equal(bound.code, 0, bound.text);
    const id = await bindingId(CONTRACT, LAW);
    assert.match(bound.text, new RegExp(`binding ${id} contract_legal \\(deployment\\) → ${LAW} status=available`));

    const again = await run('bind', CONTRACT, LAW);
    assert.equal(again.code, 0, again.text);
    assert.match(again.text, /already exists/);

    const staged = await run('bind-status', id, 'backfilling');
    assert.equal(staged.code, 0, staged.text);
    assert.match(staged.text, new RegExp(`${id} is now backfilling`));

    const runId = await seedVectorsAndRun(LAW, LAW_MODEL);

    const fewReal = await run('record-binding-evidence', comparisonFile(runId, { human: 3, synthetic_fixture: 37 }), '--binding', id);
    assert.equal(fewReal.code, 0, fewReal.text);
    const recorded = (await rows('SELECT eval_evidence FROM embedding_profile_bindings WHERE id = $1', [id]))[0]!.eval_evidence as Row;
    assert.deepEqual(recorded.doc_type_slice, { n: 40, real_n: 3, passed: true, by_language: { en: true } });
    assert.equal(recorded.baseline_global_profile, LEGACY);
    assert.equal(recorded.baseline_binding_profile, null);
    assert.equal(recorded.backfill_run_id, runId);
    assert.equal(recorded.tenant_key, null);

    const refused = await run('activate-binding', id);
    assert.equal(refused.code, 1, refused.text);
    assert.match(refused.text, /\[Embedding\] refused: binding_refused: eval_insufficient_real_items/);
    assert.equal((await rows('SELECT status FROM embedding_profile_bindings WHERE id = $1', [id]))[0]!.status, 'backfilling');

    const evidence = {
      binding_id: id,
      target_profile: LAW,
      doc_type: CONTRACT,
      tenant_key: null,
      baseline_global_profile: LEGACY,
      baseline_binding_profile: null,
      gate_passed: true,
      doc_type_slice: { n: 40, real_n: 30, passed: true, by_language: { zh: true, en: true, it: true } },
      other_slices_passed: true,
      backfill_run_id: runId,
      recorded_at: new Date().toISOString(),
    };
    const evidenceFile = path.join(tmp, 'evidence.json');
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
    const realItems = await run('record-binding-evidence', evidenceFile, '--binding', id);
    assert.equal(realItems.code, 0, realItems.text);

    assert.deepEqual(await bindings.getEffectiveBindings(TENANT_A), [], 'nothing is active before the flip');
    const activated = await run('activate-binding', id);
    assert.equal(activated.code, 0, activated.text);
    assert.match(activated.text, new RegExp(`\\[Embedding\\] activated binding contract_legal \\(deployment\\) → ${LAW}`));
    const row = (await rows('SELECT status, activated_by FROM embedding_profile_bindings WHERE id = $1', [id]))[0]!;
    assert.equal(row.status, 'active');
    assert.match(String(row.activated_by), /^cli:[A-Za-z0-9._-]+$/);
    assert.deepEqual(
      (await bindings.getEffectiveBindings(TENANT_A)).map((entry) => [entry.profile.id, entry.stale]),
      [[LAW, false]],
      'the cache was refreshed by the flip, not by its TTL',
    );

    const listed = await run('bindings');
    assert.equal(listed.code, 0, listed.text);
    const line = listed.text.split('\n').find((entry) => entry.includes(`binding ${id} `)) ?? '';
    assert.match(line, /doc_type=contract_legal tenant=deployment profile=voyage-law-2-1024 status=active stale=no evidence=yes/);

    const rollback = await run('rollback-binding', CONTRACT);
    assert.equal(rollback.code, 1, rollback.text);
    assert.match(rollback.text, /binding_refused: no_previous/);

    const deactivated = await run('deactivate-binding', CONTRACT);
    assert.equal(deactivated.code, 0, deactivated.text);
    assert.match(deactivated.text, /deactivated binding contract_legal \(deployment\)/);
    assert.equal((await rows('SELECT status FROM embedding_profile_bindings WHERE id = $1', [id]))[0]!.status, 'available');
    assert.deepEqual(await bindings.getEffectiveBindings(TENANT_A), []);
  });

  test('rollback-binding restores the previous binding of the key and exits 0', async () => {
    const runId = await seedVectorsAndRun(LAW, LAW_MODEL);
    await run('bind', CONTRACT, LAW);
    await run('bind', CONTRACT, DOMAIN);
    const law = await bindingId(CONTRACT, LAW);
    const domain = await bindingId(CONTRACT, DOMAIN);
    await fixture.db.query(
      "UPDATE embedding_profile_bindings SET status = 'available' WHERE id = $1",
      [domain],
    );
    await fixture.db.query(
      "UPDATE embedding_profile_bindings SET status = 'active', previous_binding_id = $2, activated_at = now(), activated_by = 'test', eval_evidence = $3::jsonb WHERE id = $1",
      [domain, law, JSON.stringify({ baseline_global_profile: LEGACY })],
    );
    assert.ok(runId);

    const rolled = await run('rollback-binding', CONTRACT);
    assert.equal(rolled.code, 0, rolled.text);
    assert.match(rolled.text, new RegExp(`rolled back binding contract_legal \\(deployment\\): restored ${LAW}`));
    assert.equal((await rows('SELECT status FROM embedding_profile_bindings WHERE id = $1', [law]))[0]!.status, 'active');
    assert.equal((await rows('SELECT status FROM embedding_profile_bindings WHERE id = $1', [domain]))[0]!.status, 'available');
  });

  test('bind-status never sets active, and a staged change on an active binding is refused with exit 1', async () => {
    await run('bind', CONTRACT, LAW);
    const id = await bindingId(CONTRACT, LAW);
    const viaStatus = await run('bind-status', id, 'active');
    assert.equal(viaStatus.code, 2, viaStatus.text);

    await fixture.db.query("UPDATE embedding_profile_bindings SET status = 'active', eval_evidence = $2::jsonb WHERE id = $1", [
      id,
      JSON.stringify({ baseline_global_profile: LEGACY }),
    ]);
    const onActive = await run('bind-status', id, 'retired');
    assert.equal(onActive.code, 1, onActive.text);
    assert.match(onActive.text, /binding_refused: binding_is_active/);
  });

  test('a tenant binding prints its tenant and a binding outside the profile scope is refused', async () => {
    const tenant = await run('bind', CONTRACT, LAW, '--tenant', TENANT_A);
    assert.equal(tenant.code, 0, tenant.text);
    assert.match(tenant.text, new RegExp(`contract_legal \\(${TENANT_A}\\) → ${LAW}`));

    const outside = await run('bind', 'general', LAW);
    assert.equal(outside.code, 1, outside.text);
    assert.match(outside.text, /binding_refused: profile_scope_mismatch/);
  });

  test('record-binding-evidence refuses invalid JSON with exit 2 and evidence for another binding with exit 2', async () => {
    await run('bind', CONTRACT, LAW);
    const id = await bindingId(CONTRACT, LAW);
    const broken = path.join(tmp, 'broken.json');
    fs.writeFileSync(broken, JSON.stringify({ hello: 'world' }));
    const invalid = await run('record-binding-evidence', broken, '--binding', id);
    assert.equal(invalid.code, 2, invalid.text);

    const other = path.join(tmp, 'other.json');
    fs.writeFileSync(
      other,
      JSON.stringify({
        binding_id: crypto.randomUUID(),
        target_profile: LAW,
        doc_type: CONTRACT,
        tenant_key: null,
        baseline_global_profile: LEGACY,
        baseline_binding_profile: null,
        gate_passed: true,
        doc_type_slice: { n: 40, real_n: 30, passed: true, by_language: { en: true } },
        other_slices_passed: true,
        backfill_run_id: crypto.randomUUID(),
        recorded_at: new Date().toISOString(),
      }),
    );
    const mismatch = await run('record-binding-evidence', other, '--binding', id);
    assert.equal(mismatch.code, 2, mismatch.text);
    assert.match(mismatch.text, /--binding must match/);
  });

  test('status prints the domain switch and warns about a stale active binding', async () => {
    await run('bind', CONTRACT, LAW);
    const id = await bindingId(CONTRACT, LAW);
    await fixture.db.query("UPDATE embedding_profile_bindings SET status = 'active', eval_evidence = $2::jsonb WHERE id = $1", [
      id,
      JSON.stringify({ baseline_global_profile: 'voyage-4-large-1024' }),
    ]);

    const status = await run('status');
    assert.equal(status.code, 0, status.text);
    assert.match(status.text, /domain embeddings switch: on/);
    assert.match(status.text, new RegExp(`warning: binding stale ${id} contract_legal \\(deployment\\) → ${LAW}`));

    const listed = await run('bindings');
    assert.match(listed.text, /status=active stale=yes evidence=yes/);

    useSwitches('off');
    const off = await run('status');
    assert.equal(off.code, 0, off.text);
    assert.match(off.text, /domain embeddings switch: off/);
  });
});
