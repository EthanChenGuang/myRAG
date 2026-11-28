import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createTwoTenantDatabase, TWO_TENANT_IDS, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// D-11 / T-3.1.1-11: the comparison the fixture harness writes can be recorded as evidence, but it can never activate a binding.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMITTED_RUN = path.join(REPO_ROOT, 'eval/out/p3.1.1-12/comparison.json');
const DOC_TYPE = 'contract_legal';
const REAL = new Set(['production', 'human']);

type Row = Record<string, unknown>;
type Comparison = Record<string, unknown> & {
  doc_type: string;
  fixture_embedder: boolean;
  gate_passed: boolean;
  recommended_profile: string | null;
  provenance_counts: Record<string, number>;
  reembed_run_ids: Record<string, string>;
  candidates: Array<Record<string, unknown> & { profile_id: string; model: string }>;
};

/** The harness output of `--doc-type contract_legal`: the verify run's file when present, else a fresh run into a temp dir. */
function fixtureComparison(tmp: string): Comparison {
  let file = COMMITTED_RUN;
  if (!fs.existsSync(file)) {
    const out = path.join(tmp, 'harness');
    const result = spawnSync('npx', ['tsx', 'eval/harness/run-binding-compare.mts', '--doc-type', DOC_TYPE, '--out', out], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, VOYAGE_API_KEY: '' },
      maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `the harness ran: ${(result.stderr ?? '').slice(-2000)}`);
    file = path.join(out, 'comparison.json');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Comparison;
}

describe('fixture binding comparison as activation evidence', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let cli: typeof import('@/lib/rag/embeddings/cli');
  let bindings: typeof import('@/lib/rag/embeddings/bindings');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let schema: typeof import('@/lib/rag-eval/contracts.generated');
  let tmp: string;
  let comparison: Comparison;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-compare-evidence-'));
    comparison = fixtureComparison(tmp);
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.RAG_EMBEDDING_PROFILES = 'on';
    process.env.RAG_DOMAIN_EMBEDDINGS = 'on';
    cli = await import('@/lib/rag/embeddings/cli');
    bindings = await import('@/lib/rag/embeddings/bindings');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    schema = await import('@/lib/rag-eval/contracts.generated');

    const documentId = crypto.randomUUID();
    await fixture.db.query('INSERT INTO documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
      documentId,
      'evidence-sample.md',
      'A neutral synthetic paragraph about a sample record.',
      '{}',
      TWO_TENANT_IDS.userA,
      DOC_TYPE,
    ]);
    for (let index = 0; index < 2; index += 1) {
      await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
        crypto.randomUUID(),
        documentId,
        `A neutral synthetic sentence number ${index}.`,
        index,
        '{}',
      ]);
    }
  });

  after(async () => {
    bindings?.resetBindingsForTests();
    activeProfile?.resetActiveProfileForTests();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    await edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  async function run(...argv: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await cli.main(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    return { code, text: lines.join('\n') };
  }

  /** Bind, stage, and give every in-scope chunk a vector of the profile plus a completed run, so only the evidence can refuse. */
  async function stagedBinding(profileId: string, model: string): Promise<{ bindingId: string; runId: string }> {
    await rows('DELETE FROM embedding_profile_bindings');
    const bound = await run('bind', DOC_TYPE, profileId);
    assert.equal(bound.code, 0, bound.text);
    const bindingId = String((await rows('SELECT id FROM embedding_profile_bindings WHERE profile_id = $1', [profileId]))[0]!.id);
    const staged = await run('bind-status', bindingId, 'backfilling');
    assert.equal(staged.code, 0, staged.text);
    const { rows: profile } = await fixture.db.query<{ dims: number }>('SELECT dims FROM embedding_profiles WHERE id = $1', [profileId]);
    const dims = Number(profile[0]!.dims);
    await fixture.db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
       SELECT c.id, $1, c.tenant_key, array_fill(0.1::float4, ARRAY[$3::int])::halfvec, $2, $3, now() - interval '2 hours'
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = $4
       ON CONFLICT DO NOTHING`,
      [profileId, model, dims, DOC_TYPE],
    );
    const runRow = await rows("INSERT INTO embedding_backfill_runs (profile_id, tenant_key, status) VALUES ($1, NULL, 'completed') RETURNING id", [profileId]);
    return { bindingId, runId: String(runRow[0]!.id) };
  }

  function write(name: string, value: unknown): string {
    const file = path.join(tmp, `${name}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }

  test('the harness output is a fixture comparison with no real items in the doc-type slice', () => {
    const parsed = schema.BindingComparisonSchema.safeParse(comparison);
    assert.ok(parsed.success, 'the comparison validates against the generated contract');
    assert.equal(comparison.doc_type, DOC_TYPE);
    assert.equal(comparison.fixture_embedder, true);
    assert.ok(comparison.candidates.length >= 2);
    const real = Object.entries(comparison.provenance_counts)
      .filter(([provenance]) => REAL.has(provenance))
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(real, 0);
    assert.ok((comparison.notes as string[]).some((note) => note.startsWith('Fixture evidence')));
  });

  test('recording the fixture comparison succeeds, and activation is refused', async () => {
    const candidate = comparison.candidates[0]!;
    const { bindingId, runId } = await stagedBinding(candidate.profile_id, candidate.model);
    const evidence = write('fixture', { ...comparison, reembed_run_ids: { ...comparison.reembed_run_ids, [candidate.profile_id]: runId } });

    const recorded = await run('record-binding-evidence', evidence, '--binding', bindingId);
    assert.equal(recorded.code, 0, recorded.text);
    const stored = (await rows('SELECT eval_evidence FROM embedding_profile_bindings WHERE id = $1', [bindingId]))[0]!.eval_evidence as Row;
    assert.equal(stored.gate_passed, false, 'a fixture-embedder verdict never passes');
    assert.equal((stored.doc_type_slice as Row).real_n, 0, 'synthetic items never count as real');

    const refused = await run('activate-binding', bindingId);
    assert.equal(refused.code, 1, refused.text);
    assert.match(refused.text, /refused: binding_refused: eval_failed/);
    assert.equal((await rows('SELECT status FROM embedding_profile_bindings WHERE id = $1', [bindingId]))[0]!.status, 'backfilling');
  });

  test('the same fixture comparison with its fixture flag and verdict forged is refused for its real items', async () => {
    const candidate = comparison.candidates[0]!;
    const { bindingId, runId } = await stagedBinding(candidate.profile_id, candidate.model);
    const forgedCandidates = comparison.candidates.map((entry) =>
      entry.profile_id === candidate.profile_id
        ? {
            ...entry,
            beats_baseline: true,
            beats_control: true,
            language_regressions: [],
            pair_regressions: [],
            other_slice_regressions: [],
            refusal_regressions: [],
            recommended: true,
          }
        : { ...entry, recommended: false },
    );
    const forged = {
      ...comparison,
      fixture_embedder: false,
      gate_passed: true,
      recommended_profile: candidate.profile_id,
      candidates: forgedCandidates,
      reembed_run_ids: { ...comparison.reembed_run_ids, [candidate.profile_id]: runId },
    };
    assert.ok(schema.BindingComparisonSchema.safeParse(forged).success, 'the forged file is a valid comparison');

    const recorded = await run('record-binding-evidence', write('forged', forged), '--binding', bindingId);
    assert.equal(recorded.code, 0, recorded.text);
    const stored = (await rows('SELECT eval_evidence FROM embedding_profile_bindings WHERE id = $1', [bindingId]))[0]!.eval_evidence as Row;
    assert.equal(stored.gate_passed, true);
    assert.equal((stored.doc_type_slice as Row).real_n, 0);

    const refused = await run('activate-binding', bindingId);
    assert.equal(refused.code, 1, refused.text);
    assert.match(refused.text, /refused: binding_refused: eval_insufficient_real_items/);
    assert.equal((await rows('SELECT status FROM embedding_profile_bindings WHERE id = $1', [bindingId]))[0]!.status, 'backfilling');
    assert.deepEqual(await bindings.getEffectiveBindings(`u:${TWO_TENANT_IDS.userA}`), []);
  });
});
