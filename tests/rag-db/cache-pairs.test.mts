import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CachePairsRunSchema, GoldenItemSchema, type GoldenItem, type RagRunRequest } from '../../src/lib/rag-eval/contracts.generated.ts';
import { cachePairOptions, cachePairSpecs, runCachePairs, CACHE_PAIRS_FILE } from '../../eval/harness/cache-pairs.mts';
import { runEval } from '../../eval/harness/run-eval.mts';
import { loadRunConfig } from '../../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const RUN_CONFIG = path.join(REPO_ROOT, 'eval/config/runs/query-layer-llamaindex.json');

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-pairs-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function golden(): Map<string, GoldenItem> {
  const items = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
  return new Map(items.map((item) => [item.id, item]));
}

/** Synthetic pairs on fixture anchors: punctuation-only paraphrase, a different code, and a different number word. */
function syntheticGolden(): GoldenItem[] {
  const byId = golden();
  const anchor = byId.get('en-general-001')!;
  const codeAnchor = byId.get(byId.get('en-cache-near-miss-002')!.pair_of!)!;
  const codeNearMiss = byId.get('en-cache-near-miss-002')!;
  const paraphrase = GoldenItemSchema.parse({
    ...byId.get('en-cache-paraphrase-002')!,
    id: 'en-cache-paraphrase-901',
    question: 'What is the refund window for annual plans!',
    pair_of: anchor.id,
  });
  const numberAnchor = GoldenItemSchema.parse({ ...anchor, id: 'en-general-901', question: 'What is the refund window for annual plans when the subscription covers two seats in one account?' });
  const numberNearMiss = GoldenItemSchema.parse({
    ...codeNearMiss,
    id: 'en-cache-near-miss-901',
    question: 'What is the refund window for annual plans when the subscription covers three seats in one account?',
    pair_of: numberAnchor.id,
    tags: ['near_miss_number'],
    gold_evidence: anchor.gold_evidence,
    expected_answer: anchor.expected_answer,
  });
  return [anchor, codeAnchor, numberAnchor, paraphrase, codeNearMiss, numberNearMiss];
}

function writeGolden(dir: string, items: GoldenItem[]): string {
  const file = path.join(dir, 'golden.jsonl');
  fs.writeFileSync(file, items.map((item) => JSON.stringify(item)).join('\n') + '\n');
  return file;
}

describe('cache-pair requests (D-37)', () => {
  test('pair requests drop max_results, degrade, filters and bindings, and set the cache override and the anchor seed', async () => {
    const sent: RagRunRequest[] = [];
    const items = syntheticGolden();
    const specs = cachePairSpecs(items);
    assert.deepEqual(
      specs.map((spec) => [spec.pair.id, spec.anchor.id]),
      [
        ['en-cache-paraphrase-901', 'en-general-001'],
        ['en-cache-near-miss-002', items[1]!.id],
        ['en-cache-near-miss-901', 'en-general-901'],
      ],
    );
    const options = cachePairOptions({
      max_results: 10,
      degrade: 'drop_top_candidate',
      retrieval_filters: { current_only: true, date_range: null, doc_types: null, document_ids: ['doc-1'], invoice: null, languages: null, sources: null },
      domain_control_leg: 'contract_legal',
      user_id: '00000000-0000-4000-8000-000000000001',
    });
    assert.deepEqual(options, { semantic_cache: 'pgvector', user_id: '00000000-0000-4000-8000-000000000001' });
    let cleared = 0;
    await runCachePairs({
      specs: specs.slice(0, 1),
      options,
      clear: async () => {
        cleared += 1;
      },
      send: async (payload) => {
        sent.push(payload);
        return {
          status: 200,
          body: {
            stage_status: { semantic_cache: 'ok' },
            stage_counts: { semantic_cache: payload.options?.cache_seed_answer ? { hit: 0 } : { hit: 1, distance: 0.01 } },
          },
        };
      },
    });
    assert.equal(cleared, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.query, 'What is the refund window for annual plans?');
    assert.equal(sent[0]!.options?.cache_seed_answer, items[0]!.expected_answer);
    assert.equal(sent[1]!.options?.cache_seed_answer, undefined);
    for (const payload of sent) {
      assert.equal(payload.options?.max_results, undefined);
      assert.equal(payload.options?.degrade, undefined);
      assert.equal(payload.options?.retrieval_filters, undefined);
      assert.deepEqual(payload.conversation, []);
    }
  });

  test('a --base-url run refuses to run without --allow-live-cache', async () => {
    const dir = makeTmpDir();
    await assert.rejects(
      runEval({
        goldenPath: writeGolden(dir, syntheticGolden()),
        corpusDir: CORPUS_DIR,
        outDir: dir,
        deploymentMode: 'single-tenant',
        baseUrl: 'https://eval.example.invalid',
        cachePairs: true,
      }),
      /allow-live-cache/,
    );
  });
});

describe('cache-pair run on PGlite (D-37)', () => {
  test('starts from an empty cache, stores each anchor, checks its candidate and writes cache-pairs.json', async () => {
    const dir = makeTmpDir();
    const result = await runEval({
      goldenPath: writeGolden(dir, syntheticGolden()),
      corpusDir: CORPUS_DIR,
      outDir: dir,
      deploymentMode: 'single-tenant',
      runConfig: loadRunConfig(RUN_CONFIG),
      cachePairs: true,
    });
    assert.equal(result.cachePairsPath, path.join(dir, CACHE_PAIRS_FILE));
    const run = CachePairsRunSchema.parse(JSON.parse(fs.readFileSync(result.cachePairsPath!, 'utf8')));
    assert.equal(run.source, 'fixture');
    assert.equal(run.embedding_profile_id, 'fixture-ngram');
    assert.equal(run.probe_max_distance, 0.2);
    assert.ok(run.pairs, 'the run lists its pairs');
    assert.equal(run.pairs.length, 3);
    const rows = new Map(run.pairs.map((row) => [row.pair_id, row]));

    const paraphrase = rows.get('en-cache-paraphrase-901')!;
    assert.equal(paraphrase.outcome, 'hit', JSON.stringify(paraphrase));
    assert.equal(paraphrase.anchor_outcome, 'miss');
    assert.ok(paraphrase.distance !== null && paraphrase.distance !== undefined && paraphrase.distance < 0.05);
    assert.equal(paraphrase.split, 'dev');

    const code = rows.get('en-cache-near-miss-002')!;
    assert.equal(code.outcome, 'bypass');
    assert.equal(code.bypass_reason, 'protected_tokens');
    assert.equal(code.hit, false);

    const number = rows.get('en-cache-near-miss-901')!;
    assert.equal(number.category, 'cache_near_miss');
    assert.equal(number.outcome, 'hit', JSON.stringify(number));
    assert.equal(typeof number.distance, 'number');
    assert.ok(number.distance! > paraphrase.distance!);
  });
});
