import test from 'node:test';
import assert from 'node:assert/strict';
import { filterDiagnostics, evaluateTsc } from './typecheck-new.mjs';

test('keeps Phase 1 diagnostics and drops legacy ones', () => {
  const text = [
    "tests/x.test.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/lib/rag-eval/auth.ts(1,1): error TS2304: Cannot find name 'foo'.",
    "src/lib/semantic-chunker.ts(10,2): error TS2345: legacy.",
    "eval/harness/run-smoke.mts(4,1): error TS7006: Parameter 'a' implicitly has an 'any' type.",
    "src/app/api/internal/rag/run/route.ts(2,2): error TS2307: Cannot find module.",
    "vitest.config.ts(1,1): error TS2307: Cannot find module.",
  ].join('\n');
  const { kept, ignored, total } = filterDiagnostics(text);
  assert.equal(total, 6);
  assert.equal(ignored, 1);
  assert.equal(kept.length, 5);
  assert.ok(kept.every((l) => !l.includes('semantic-chunker')));
});

test('keeps indented continuation lines only for kept diagnostics', () => {
  const text = [
    'tests/a.ts(1,1): error TS2322: outer.',
    "  Type 'a' is not assignable to type 'b'.",
    'src/lib/title-generator.ts(1,1): error TS2322: legacy.',
    '  legacy detail line.',
  ].join('\n');
  const { kept, ignored } = filterDiagnostics(text);
  assert.equal(ignored, 1);
  assert.deepEqual(kept, ['tests/a.ts(1,1): error TS2322: outer.', "  Type 'a' is not assignable to type 'b'."]);
});

test('similarly named paths outside Phase 1 are legacy', () => {
  const text = [
    'src/lib/rag-eval-old/x.ts(1,1): error TS1: a.',
    'tests-legacy/x.ts(1,1): error TS1: b.',
    'src/lib/enhanced-rag-retrieval.ts(1,1): error TS1: c.',
  ].join('\n');
  const { kept, ignored } = filterDiagnostics(text);
  assert.equal(kept.length, 0);
  assert.equal(ignored, 3);
});

test('a global compiler error is kept', () => {
  const { kept } = filterDiagnostics("error TS5083: Cannot read file 'tsconfig.json'.");
  assert.equal(kept.length, 1);
});

test('output without diagnostics yields zero total', () => {
  const { kept, ignored, total } = filterDiagnostics('Segmentation fault');
  assert.equal(total, 0);
  assert.equal(kept.length, 0);
  assert.equal(ignored, 0);
});

test('a non-zero tsc exit with no parseable diagnostics is a failure', () => {
  const r = evaluateTsc(1, 'Segmentation fault');
  assert.equal(r.ok, false);
  assert.match(r.message, /tool crash/);
});

test('legacy-only diagnostics pass and report the ignored count', () => {
  const r = evaluateTsc(2, 'src/lib/semantic-chunker.ts(10,2): error TS2345: legacy.');
  assert.equal(r.ok, true);
  assert.match(r.message, /ignored 1 legacy/);
});

test('a Phase 1 diagnostic fails', () => {
  const r = evaluateTsc(2, 'tests/x.test.ts(3,7): error TS2322: bad.');
  assert.equal(r.ok, false);
});
