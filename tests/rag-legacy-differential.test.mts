import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureDatabase, type FixtureDatabase } from '../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../eval/harness/fake-edge.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');

const questions: string[] = fs
  .readFileSync(GOLDEN, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => (JSON.parse(line) as { question: string }).question);

interface FrozenLegacyOutput {
  question: string;
  chunks: unknown[];
  queryContext: unknown;
}

// Output of the retired enhancedRetrieveChunks for each fixture question, frozen before its deletion.
const frozen: FrozenLegacyOutput[] = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/characterization/legacy-candidates.json'), 'utf8'),
);

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('runRetrieval through the re-homed legacy search equals the frozen enhancedRetrieveChunks output', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let deps: typeof import('@/lib/rag/deps');

  before(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    rag = await import('@/lib/rag');
    scopeModule = await import('@/lib/rag/tenant/scope');
    deps = await import('@/lib/rag/deps');
  });

  after(async () => {
    deps?.resetRagDepsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  test('the frozen output covers the 72 questions of the golden set at the time of the freeze', () => {
    assert.equal(frozen.length, 72);
    const golden = new Set(questions);
    for (const entry of frozen) assert.ok(golden.has(entry.question), `frozen question is not in the golden set: ${entry.question}`);
    assert.deepEqual(
      frozen.map((entry) => entry.question),
      questions.filter((question) => frozen.some((entry) => entry.question === question)),
    );
  });

  test('all 72 frozen fixture questions return deep-equal candidates and query context', async () => {
    const scope = scopeModule.mintScope('single', null, null);
    let equal = 0;
    let withCandidates = 0;
    for (const { question, chunks, queryContext } of frozen) {
      const old = { chunks, queryContext };
      const fresh = await rag.runRetrieval({
        scope,
        query: question,
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      });
      assert.deepStrictEqual(roundTrip(fresh.candidates), old.chunks, `candidates differ for: ${question}`);
      assert.deepStrictEqual(roundTrip(fresh.queryContext), old.queryContext, `query context differs for: ${question}`);
      if (old.chunks.length === 0) {
        assert.equal(fresh.status, 'empty', `status for: ${question}`);
        assert.equal(fresh.reason, 'no_candidates', `reason for: ${question}`);
      } else if (fresh.status === 'empty') {
        assert.equal(fresh.reason, 'no_relevant_context', `reason for: ${question}`);
        assert.equal(fresh.usedDocuments.length + fresh.relevantChunks.length, 0, `survivors for: ${question}`);
      } else {
        assert.equal(fresh.status, 'ok', `status for: ${question}`);
      }
      equal += 1;
      if (old.chunks.length > 0) withCandidates += 1;
    }
    assert.equal(equal, 72);
    assert.ok(withCandidates >= 36, `only ${withCandidates} questions returned candidates`);
    assert.deepEqual(edge.errors, []);
  });

  test('a null scope returns empty/no_tenant without running a stage', async () => {
    const before = edge.calls.length;
    const result = await rag.runRetrieval({ scope: null, query: questions[0], profile: 'eval', signal: new AbortController().signal });
    assert.equal(result.status, 'empty');
    assert.equal(result.reason, 'no_tenant');
    assert.deepEqual(result.stages, []);
    assert.equal(edge.calls.length, before);
  });

  test('an RPC error is status error, not an empty result', async () => {
    const failing = {
      rpc: () => {
        const request = {
          abortSignal: () => request,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }).then(resolve),
        };
        return request;
      },
    };
    deps.setRagDepsForTests({ anonClient: () => failing as never });
    try {
      const result = await rag.runRetrieval({
        scope: scopeModule.mintScope('single', null, null),
        query: questions[0],
        profile: 'eval',
        signal: new AbortController().signal,
      });
      assert.equal(result.status, 'error');
      assert.equal(result.reason, 'backend_error');
      assert.deepEqual(result.candidates, []);
    } finally {
      deps.resetRagDepsForTests();
    }
  });

  test('an aborted signal is reported as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await rag.runRetrieval({
      scope: scopeModule.mintScope('single', null, null),
      query: questions[0],
      profile: 'eval',
      signal: controller.signal,
    });
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'aborted');
  });
});
