import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 03.3 verification G3 (SC4: values flagged for the identifier index are found by the RET-16 exact filter). One child process per
 * deployment mode (identifier-attribute-run.mts): a code attribute flagged in_identifier_index is imported with rag:attributes, the
 * rag:identifiers backfill runs, then a v2 query naming the value runs with RAG_IDENTIFIER_INDEX and RAG_IDENTIFIER_FILTER on. The value
 * is only in the attributes, never in the text, so only the attribute feed can make the filter find it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Summary {
  count: number;
  familyDocs: number;
  onlyTarget: boolean;
  hasTarget: boolean;
  hasNearMiss: boolean;
  foreign: number;
  identifier: { asked: number; resolved: number; fallback: boolean } | null;
  identifierStage: string | null;
}

function runFlow(mode: 'multi-tenant' | 'single-tenant'): Record<string, unknown> {
  const out = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'tests/rag-db/identifier-attribute-run.mts'), mode], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 300_000,
  });
  assert.equal(out.status, 0, `identifier attribute run (${mode}) failed: ${out.stderr.slice(-2000)}`);
  return JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>;
}

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`attribute values in the RET-16 identifier filter (${mode}, 03.3 G3)`, () => {
    let report: Record<string, unknown>;
    const part = (name: string) => report[name] as Summary;

    before(() => {
      report = runFlow(mode);
    });

    test('the imported value reaches the chunk identifiers after rag:identifiers, and the text never holds it', () => {
      assert.equal(report.targetChunkHasIdentifier, true);
      assert.equal(report.contentHasValue, false);
    });

    test('switches off: several documents of the family, the one-character look-alike among them', () => {
      const off = part('off');
      assert.ok(off.familyDocs > 1, `expected several family documents, got ${off.familyDocs}`);
      assert.equal(off.hasNearMiss, true);
      assert.equal(off.identifier, null);
    });

    test('both switches on: only the document carrying the value is returned', () => {
      const on = part('on');
      assert.equal(on.identifierStage, 'ok');
      assert.deepEqual([on.identifier?.asked, on.identifier?.resolved, on.identifier?.fallback], [1, 1, false]);
      assert.equal(on.hasTarget, true);
      assert.equal(on.onlyTarget, true, 'a candidate of another document');
      assert.equal(on.hasNearMiss, false);
      assert.equal(on.foreign, 0, 'no candidate of the other tenant carrying the same value');
    });

    test('both switches on, a question naming no identifier is not filtered', () => {
      const plain = part('plainOn');
      assert.equal(plain.identifier?.asked, 0);
      assert.ok(plain.familyDocs > 1);
    });
  });
}
