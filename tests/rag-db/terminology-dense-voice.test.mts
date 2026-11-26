import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import type { TerminologySeedRow } from '../../eval/harness/pglite-supabase.mts';
import type { BackendSearchRequest, RetrievalBackend } from '../../src/lib/rag/backend/types.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/terminology-corpus');
const ROUTE_PATH = '/api/internal/rag/run';

/** D-37: placeholder terms only; the variant occurs in no chunk, the canonical in exactly one (plan 05's synthetic corpus). */
const VARIANT = 'termalpha';
const CANONICAL = 'term alpha beta';

const SEED: TerminologySeedRow[] = [
  { layer: 'shared', canonical: CANONICAL, variants: [VARIANT], language: 'en', kind: 'synonym', mode: 'one_way' },
];

interface Candidate {
  chunk_id: string;
  content: string;
  fused_score?: number;
  legs?: Record<string, number>;
}

interface TraceBody {
  stage_status: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
  stages?: Array<{ name: string; detail?: string | null }>;
  candidates: Candidate[];
}

let prepared: InProcessEval;
const searches: BackendSearchRequest[] = [];
const embedded: string[] = [];

type Switch = 'true' | 'false';

/** The app env is a snapshot taken at import; the switches are flipped per request through the deps seam. */
async function withSwitches<T>(terminology: Switch, dense: Switch, fn: () => Promise<T>): Promise<T> {
  const deps = await import('../../src/lib/rag/deps.ts');
  const previous = deps.getRagDeps();
  const previousEnv = previous.ragEnv;
  const previousEmbedder = previous.embedder;
  deps.setRagDepsForTests({
    ragEnv: () => ({ ...previousEnv(), RAG_TERMINOLOGY: terminology, RAG_TERMINOLOGY_DENSE: dense }),
    embedder: (text, options) => {
      embedded.push(text);
      return previousEmbedder(text, options);
    },
  });
  searches.length = 0;
  embedded.length = 0;
  try {
    return await fn();
  } finally {
    deps.setRagDepsForTests({ ragEnv: previousEnv, embedder: previousEmbedder });
  }
}

async function postEval(query: string, itemId: string): Promise<TraceBody> {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({ schema_version: 1, query, item_id: itemId, rag_mode: 'strict', options: {} }),
  });
  const res = await prepared.POST(req);
  const json = (await res.json()) as TraceBody;
  assert.equal(res.status, 200, JSON.stringify(json).slice(0, 500));
  return json;
}

async function weightsInForce() {
  const { loadRagConfig } = await import('../../src/lib/rag/config.ts');
  const { effectiveRetrievalParams } = await import('../../src/lib/rag/v2/retrieval-params.ts');
  const { terminologyParams } = await import('../../src/lib/rag/terminology/expand.ts');
  const { getRagDeps } = await import('../../src/lib/rag/deps.ts');
  const params = effectiveRetrievalParams('eval', loadRagConfig(getRagDeps().ragEnv()));
  const terms = terminologyParams();
  return {
    k: params.rrf_k,
    dense: params.leg_weights?.dense ?? 1,
    lexical: params.leg_weights?.lexical ?? 1,
    denseWeight: terms.dense_weight,
    expansionWeight: terms.expansion_weight,
  };
}

const isTermCall = (req: BackendSearchRequest) => req.denseVector === null && req.lexicalTokens.length > 0;
const isDenseOnlyVariant = (req: BackendSearchRequest) => req.denseVector !== null && req.lexicalTokens.length === 0;

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'single-tenant',
    // D-36: pipeline and languages set explicitly, never the shipped default.
    envOverrides: {
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
      RAG_PRIMARY_LANGUAGE: 'en',
      RAG_TERMINOLOGY: 'false',
      RAG_TERMINOLOGY_DENSE: 'false',
    },
    terminologySeed: SEED,
  });
  const registry = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  registry.resetRetrievalBackendForTests();
  const real = registry.getRetrievalBackend();
  const recording: RetrievalBackend = {
    id: real.id,
    search: (req) => {
      searches.push(req);
      return real.search(req);
    },
    ...(real.searchTranslations ? { searchTranslations: real.searchTranslations.bind(real) } : {}),
    health: () => real.health(),
    isReady: (scope) => real.isReady(scope),
  };
  registry.setRetrievalBackendForTests(recording);
  resetV2StartupForTests();
  await verifyV2Startup();
});

after(async () => {
  const registry = await import('../../src/lib/rag/backend/registry.ts');
  registry.resetRetrievalBackendForTests();
  await prepared?.close();
});

describe('the dense terminology variant and the voice rule through the eval route', () => {
  test('both switches on: one dense-only variant call, its list weighted at dense_weight × the dense leg weight', async () => {
    const body = await withSwitches('true', 'true', async () => {
      const response = await postEval(VARIANT, 'term-dense-on');
      return { response, calls: [...searches], texts: [...embedded] };
    });
    const { response, calls, texts } = body;
    assert.equal(response.stage_status.terminology, 'ok');

    const denseOnly = calls.filter(isDenseOnlyVariant);
    assert.equal(denseOnly.length, 1, 'exactly one dense-only variant call');
    assert.equal(calls.filter(isTermCall).length, 1, 'term:0 still runs');
    const variantCalls = calls.filter((req) => req.denseVector !== null);
    assert.equal(variantCalls.length, 2, 'the original and the terminology variant');

    // One embed batch: every embedder input belongs to a searched variant, and the substituted text is one of them.
    assert.ok(texts.includes(CANONICAL), 'the terminology text is embedded');
    assert.equal(texts.length, variantCalls.length, 'no second embed call');

    const weights = await weightsInForce();
    const termDense = weights.denseWeight * weights.dense;
    assert.ok(termDense < weights.dense, 'the variant list weighs less than the original dense list');
    let sawVariantLeg = false;
    for (const row of response.candidates) {
      const legs = row.legs ?? {};
      assert.equal(legs['lexical:1'], undefined, 'no lexical list for the terminology variant');
      if (legs['dense:1'] !== undefined) sawVariantLeg = true;
      let expected = 0;
      for (const [list, rank] of Object.entries(legs)) {
        const weight =
          list === 'dense:1' ? termDense : list.startsWith('dense:') ? weights.dense : list.startsWith('lexical:') ? weights.lexical : list === 'term:0' ? weights.expansionWeight * weights.lexical : NaN;
        expected += weight / (weights.k + rank);
      }
      assert.ok(typeof row.fused_score === 'number');
      assert.ok(Math.abs(row.fused_score - expected) < 1e-9, `fused ${row.fused_score} vs ${expected} for legs ${JSON.stringify(legs)}`);
    }
    assert.ok(sawVariantLeg, 'some candidate was found through the terminology variant');

    const counts = response.stage_counts?.terminology ?? {};
    assert.equal(counts.search_cut, 0);
    assert.equal(counts.variant_cut, 0);
  });

  test('dense switch off: no terminology variant, the stage still reports its matches', async () => {
    const { response, calls } = await withSwitches('true', 'false', async () => ({ response: await postEval(VARIANT, 'term-dense-off'), calls: [...searches] }));
    assert.equal(response.stage_status.terminology, 'ok');
    assert.equal(response.stage_counts?.terminology?.matches, 1);
    assert.equal(calls.filter(isDenseOnlyVariant).length, 0);
    assert.equal(calls.filter(isTermCall).length, 1);
    assert.ok(response.candidates.every((row) => row.legs?.['dense:1'] === undefined));
  });

  test('voice never gets the terminology variant, whatever the switches; term:0 still runs', async () => {
    const rag = await import('../../src/lib/rag/index.ts');
    const scoped = rag.evalScope({ deploymentMode: 'single-tenant', organizationId: null, userId: null, allowedScopes: '' });
    assert.ok(scoped.ok, 'single-tenant scope');
    const { result, calls } = await withSwitches('true', 'true', async () => ({
      result: await rag.runRetrieval({ scope: scoped.scope, query: VARIANT, profile: 'voice', options: { ragMode: 'strict' }, signal: new AbortController().signal }),
      calls: [...searches],
    }));
    const record = result.stages.find((stage) => stage.name === 'terminology');
    assert.equal(record?.status, 'ok');
    assert.equal(calls.filter(isDenseOnlyVariant).length, 0, 'no dense-only variant in voice');
    assert.equal(calls.filter((req) => req.denseVector !== null).length, 1, 'only the original variant');
    assert.equal(calls.filter(isTermCall).length, 1, 'the term:0 lexical expansion runs in voice');
    assert.equal(record?.counts?.variant_cut, 0);
  });

  test('stage counts carry search_cut and variant_cut; nothing in the trace holds query, variant or canonical text', async () => {
    const response = await withSwitches('true', 'true', () => postEval(VARIANT, 'term-dense-privacy'));
    const counts = response.stage_counts?.terminology ?? {};
    assert.deepEqual(
      Object.keys(counts).sort(),
      ['capped', 'matches', 'search_cut', 'shared_version', 'tokens', 'variant_cut', 'workspace_version'],
    );
    const record = JSON.stringify({ counts, stage: (response.stages ?? []).find((stage) => stage.name === 'terminology') ?? null });
    for (const text of [VARIANT, CANONICAL]) assert.ok(!record.includes(text), `trace holds ${text}`);
  });
});
