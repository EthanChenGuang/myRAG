import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GROUPINGS,
  OUT_OF_DOMAIN_IDS,
  SCOPE_SEPARATION_REAL_DIR,
  SCOPE_SEPARATION_REPORT_PATH,
  reportTextLeaks,
  requiredEmbeddingKey,
  runScopeSeparation,
  runScopeSeparationCli,
  stableJson,
  type ScopeSeparationReport,
  type SeparationEmbedderFactory,
} from '../../eval/harness/scope-separation.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface GoldenRow {
  id: string;
  category: string;
  question: string;
}

describe('scope separation measurement on the committed fixtures (D-34, F-12)', () => {
  let first: ScopeSeparationReport;
  let second: ScopeSeparationReport;

  before(async () => {
    first = await runScopeSeparation();
    second = await runScopeSeparation();
  });

  test('two runs give byte-identical reports', () => {
    assert.equal(stableJson(first), stableJson(second));
  });

  test('the committed report is the tool output', () => {
    assert.ok(fs.existsSync(SCOPE_SEPARATION_REPORT_PATH), 'report.json is committed');
    assert.equal(fs.readFileSync(SCOPE_SEPARATION_REPORT_PATH, 'utf8'), stableJson(first));
  });

  test('centroids come from the D-34 language-specific keys and every grouping is measured', () => {
    assert.ok((first.centroids_by_kind.doc_type ?? 0) > 0);
    assert.ok((first.centroids_by_kind.tenant ?? 0) > 1, 'one tenant centroid per language');
    assert.deepEqual(Object.keys(first.groupings).sort(), [...GROUPINGS].sort());
    assert.equal(first.groupings.tenant.centroids, 1);
    assert.ok(first.groupings.doc_type_language.centroids > first.groupings.doc_type.centroids);
    assert.equal(first.counts.out_of_domain, OUT_OF_DOMAIN_IDS.length);
    assert.ok(first.counts.near_miss > 0 && first.counts.answerable > 0 && first.counts.cross_lingual > 0);
  });

  test('the verdict compares the D-34 keys with doc-type keys and matches the counts', () => {
    const { verdict, groupings } = first;
    assert.deepEqual(verdict.compared, ['doc_type_language', 'doc_type']);
    assert.equal(verdict.out_of_domain_below.doc_type_language, groupings.doc_type_language.out_of_domain_below.total);
    assert.equal(verdict.out_of_domain_below.doc_type, groupings.doc_type.out_of_domain_below.total);
    assert.equal(
      verdict.d34_separates_at_least_as_well,
      verdict.out_of_domain_below.doc_type_language >= verdict.out_of_domain_below.doc_type &&
        verdict.answerable_below.doc_type_language <= verdict.answerable_below.doc_type,
    );
  });

  test('the out-of-domain ids are no_answer items of the golden set', () => {
    const rows = fs
      .readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as GoldenRow);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of OUT_OF_DOMAIN_IDS) assert.equal(byId.get(id)?.category, 'no_answer', id);
  });

  test('the report carries ids, counts and scores rounded to three decimals, never question or translation text', () => {
    const text = stableJson(first);
    const golden = fs
      .readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as GoldenRow);
    const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/fixtures/translation-table.json'), 'utf8')) as {
      entries: Array<{ translations: Array<{ text: string }> }>;
    };
    const texts = [...golden.map((row) => row.question), ...table.entries.flatMap((entry) => entry.translations.map((t) => t.text))];
    for (const value of texts) assert.ok(!text.includes(JSON.stringify(value).slice(1, -1)), 'question text in the report');
    for (const item of first.items) {
      assert.deepEqual(Object.keys(item).sort(), ['class', 'id', 'pair', 'scores', 'split']);
      for (const score of Object.values(item.scores)) assert.equal(Math.round(score * 1000) / 1000, score);
    }
    for (const grouping of Object.values(first.groupings)) assert.equal(Math.round(grouping.threshold * 1000) / 1000, grouping.threshold);
  });
});

describe('scope separation with a real embedding profile (06.2-42, D-34 review)', () => {
  let fixture: ScopeSeparationReport;
  const seen = { documents: 0, queries: 0, calls: 0 };

  before(async () => {
    fixture = JSON.parse(fs.readFileSync(SCOPE_SEPARATION_REPORT_PATH, 'utf8')) as ScopeSeparationReport;
  });

  function countingFixtureEmbedder(): SeparationEmbedderFactory {
    return (profile) => ({
      name: `fake:fake-${profile.dims}`,
      async embedDocuments(texts) {
        seen.documents += texts.length;
        seen.calls += 1;
        return texts.map((text) => embedText(text, profile.dims));
      },
      async embedQueries(texts) {
        seen.queries += texts.length;
        seen.calls += 1;
        return texts.map((text) => embedText(text, profile.dims));
      },
    });
  }

  test('the default real output directory is q62-scope-separation-real', () => {
    assert.equal(path.relative(REPO_ROOT, SCOPE_SEPARATION_REAL_DIR), 'eval/reports/q62-scope-separation-real');
  });

  test('an injected embedder serves chunks and questions; the same vectors give the fixture groupings', async () => {
    const report = await runScopeSeparation({ embedding: { profile: 'openai-3-small-1536', create: countingFixtureEmbedder() } });
    assert.equal(report.embedder, 'fake:fake-1536');
    assert.equal(report.embedding_profile, 'openai-3-small-1536');
    assert.ok(seen.documents > 500, 'every current chunk is embedded');
    assert.ok(seen.queries >= fixture.counts.answerable + fixture.counts.out_of_domain + fixture.counts.near_miss);
    assert.equal(report.embedding_run?.texts, seen.documents + seen.queries);
    assert.equal(report.embedding_run?.calls, seen.calls);
    assert.deepEqual(report.groupings, fixture.groupings);
    assert.deepEqual(report.verdict.out_of_domain_below, fixture.verdict.out_of_domain_below);
    assert.ok(!stableJson(report).includes('fixture-ngram'));
  });

  test('a halfvec profile rebuilds its centroids from chunk_embeddings written with the injected vectors', async () => {
    const constant: SeparationEmbedderFactory = (profile) => {
      const unit = new Array<number>(profile.dims).fill(0);
      unit[0] = 1;
      return { name: 'fake:constant', embedDocuments: async (t) => t.map(() => unit), embedQueries: async (t) => t.map(() => unit) };
    };
    const report = await runScopeSeparation({ embedding: { profile: 'bge-m3-1024', create: constant } });
    assert.equal(report.embedding_profile, 'bge-m3-1024');
    assert.ok((report.centroids_by_kind.doc_type ?? 0) > 0);
    for (const item of report.items) for (const score of Object.values(item.scores)) assert.equal(score, 1);
    for (const grouping of Object.values(report.groupings)) assert.equal(grouping.out_of_domain_below.total, 0);
  });

  test('an unknown profile and vectors of the wrong length are refused', async () => {
    await assert.rejects(
      runScopeSeparation({ embedding: { profile: 'no-such-profile', create: countingFixtureEmbedder() } }),
      /unknown_embedding_profile/,
    );
    const short: SeparationEmbedderFactory = () => ({
      name: 'fake:short',
      embedDocuments: async (t) => t.map(() => [1, 0, 0]),
      embedQueries: async (t) => t.map(() => [1, 0, 0]),
    });
    await assert.rejects(runScopeSeparation({ embedding: { profile: 'openai-3-small-1536', create: short } }), /embedding_dims_mismatch/);
  });

  test('real mode without the provider key exits 2 with embedding_key_missing and writes nothing', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-42-'));
    const errors: string[] = [];
    const code = await runScopeSeparationCli(['--embedder', 'real', '--profile', 'openai-3-small-1536', '--out', out], {
      env: {},
      log: () => undefined,
      error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    });
    assert.equal(code, 2);
    assert.ok(errors.some((line) => line.includes('embedding_key_missing') && line.includes('OPENAI_API_KEY')));
    assert.deepEqual(fs.readdirSync(out), []);
    assert.equal(requiredEmbeddingKey({ provider: 'voyage' }, {}), 'VOYAGE_API_KEY');
    assert.equal(requiredEmbeddingKey({ provider: 'openai' }, { RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' }), 'OPENROUTER_API_KEY');
  });

  test('the CLI writes report.json and report.md into the --out directory, with no text', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-42-'));
    const code = await runScopeSeparationCli(['--embedder', 'real', '--profile', 'openai-3-small-1536', '--out', out], {
      env: {},
      embedderFor: countingFixtureEmbedder(),
      log: () => undefined,
      error: () => undefined,
    });
    assert.equal(code, 0);
    assert.deepEqual(fs.readdirSync(out).sort(), ['report.json', 'report.md']);
    const json = fs.readFileSync(path.join(out, 'report.json'), 'utf8');
    const report = JSON.parse(json) as ScopeSeparationReport;
    assert.deepEqual(reportTextLeaks(json), []);
    const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    for (const grouping of GROUPINGS) assert.ok(md.includes(`| ${grouping} |`), grouping);
    assert.ok(md.includes(String(report.verdict.d34_separates_at_least_as_well)));
    assert.deepEqual(reportTextLeaks(md), []);
  });

  test('the text check catches a question in a report', () => {
    const row = fs
      .readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .find((line) => line.trim() !== '');
    const question = (JSON.parse(row!) as GoldenRow).question;
    assert.equal(reportTextLeaks(JSON.stringify({ note: question })).length, 1);
  });
});
