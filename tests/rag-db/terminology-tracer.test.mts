import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { loadCorpus } from '../../eval/harness/corpus.mts';
import type { TerminologySeedRow } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/terminology-corpus');
const ROUTE_PATH = '/api/internal/rag/run';

/** D-37: placeholder terms only. Each variant is a made-up token that occurs in no chunk; each canonical is in exactly one chunk. */
const CASES = [
  { language: 'en', variant: 'termalpha', canonical: 'term alpha beta' },
  { language: 'it', variant: 'vocealfa', canonical: 'termine alfa beta' },
  { language: 'zh', variant: 'termgamma', canonical: '术语甲乙丙' },
] as const;

const SEED: TerminologySeedRow[] = CASES.map((entry) => ({
  layer: 'shared',
  canonical: entry.canonical,
  variants: [entry.variant],
  language: entry.language,
  kind: 'synonym',
  mode: 'one_way',
}));

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

async function postEval(query: string, itemId: string) {
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

/** The app env is a snapshot taken at import; the switch is flipped per request through the deps seam. */
async function withTerminology<T>(value: 'true' | 'false', fn: () => Promise<T>): Promise<T> {
  const deps = await import('../../src/lib/rag/deps.ts');
  const previous = deps.getRagDeps().ragEnv;
  deps.setRagDepsForTests({ ragEnv: () => ({ ...previous(), RAG_TERMINOLOGY: value }) });
  try {
    return await fn();
  } finally {
    deps.setRagDepsForTests({ ragEnv: previous });
  }
}

async function expectedTermContribution(): Promise<number> {
  const { loadRagConfig } = await import('../../src/lib/rag/config.ts');
  const { effectiveRetrievalParams } = await import('../../src/lib/rag/v2/retrieval-params.ts');
  const { TerminologyParamsSchema } = await import('../../src/lib/rag-eval/contracts.generated.ts');
  const { getRagDeps } = await import('../../src/lib/rag/deps.ts');
  const params = effectiveRetrievalParams('eval', loadRagConfig(getRagDeps().ragEnv()));
  const lexicalWeight = params.leg_weights?.lexical ?? 1;
  const expansionWeight = TerminologyParamsSchema.parse({}).expansion_weight;
  return (expansionWeight * lexicalWeight) / (params.rrf_k + 1);
}

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
    },
    terminologySeed: SEED,
  });
  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();
});

after(async () => {
  await prepared?.close();
});

describe('terminology tracer through the eval route', () => {
  test('no variant shares a lexical token with any chunk of the synthetic corpus', async () => {
    const { queryLexicalTokens, lexicalTokens } = await import('../../src/lib/rag/lexical/tokenize.ts');
    const corpusTokens = new Set(loadCorpus(CORPUS_DIR).documents.flatMap((doc) => doc.chunks.flatMap((chunk) => lexicalTokens(chunk.stored))));
    for (const entry of CASES) {
      for (const token of queryLexicalTokens(entry.variant)) assert.ok(!corpusTokens.has(token), `variant token ${token} occurs in the corpus`);
      const holders = loadCorpus(CORPUS_DIR).documents.flatMap((doc) => doc.chunks).filter((chunk) => chunk.text.includes(entry.canonical));
      assert.equal(holders.length, 1, `exactly one chunk holds ${entry.language}'s canonical`);
    }
  });

  for (const entry of CASES) {
    test(`${entry.language}: an informal variant reaches the canonical chunk through term:0`, async () => {
      const off = await withTerminology('false', () => postEval(entry.variant, `term-off-${entry.language}`));
      const on = await withTerminology('true', () => postEval(entry.variant, `term-on-${entry.language}`));

      assert.equal(off.stage_status.terminology, 'disabled');
      assert.ok(off.candidates.every((row) => row.legs?.['term:0'] === undefined), 'no term:0 leg with the switch off');

      assert.equal(on.stage_status.terminology, 'ok');
      assert.equal(on.stage_counts?.terminology?.matches, 1);
      assert.ok((on.stage_counts?.terminology?.tokens ?? 0) >= 1);
      const gold = on.candidates.find((row) => row.content.includes(entry.canonical));
      assert.ok(gold, 'the canonical chunk is a candidate with the switch on');
      assert.equal(gold.legs?.['term:0'], 1);
      assert.equal(gold.legs?.['lexical:0'], undefined, 'the original lexical leg never found the canonical chunk');

      const goldOff = off.candidates.find((row) => row.chunk_id === gold.chunk_id);
      const offScore = goldOff?.fused_score ?? 0;
      assert.ok(typeof gold.fused_score === 'number');
      const expected = await withTerminology('true', expectedTermContribution);
      assert.ok(Math.abs(gold.fused_score - offScore - expected) < 1e-9, `fused delta ${gold.fused_score - offScore} vs ${expected}`);
    });
  }

  test('the stage counts and detail carry no query, variant or canonical text', async () => {
    const on = await withTerminology('true', () => postEval(CASES[0].variant, 'term-privacy'));
    const counts = JSON.stringify(on.stage_counts?.terminology ?? {});
    for (const entry of CASES) {
      assert.ok(!counts.includes(entry.variant) && !counts.includes(entry.canonical));
    }
    assert.deepEqual(Object.keys(on.stage_counts?.terminology ?? {}).sort(), ['capped', 'matches', 'search_cut', 'shared_version', 'tokens', 'variant_cut', 'workspace_version']);
  });
});
