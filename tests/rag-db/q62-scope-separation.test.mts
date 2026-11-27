import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GROUPINGS,
  OUT_OF_DOMAIN_IDS,
  SCOPE_SEPARATION_REPORT_PATH,
  runScopeSeparation,
  stableJson,
  type ScopeSeparationReport,
} from '../../eval/harness/scope-separation.mts';

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
