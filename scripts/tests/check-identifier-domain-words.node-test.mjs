import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkIdentifierDomainWords, wordsOf } from '../ci/check-identifier-domain-words.mjs';

function makeRoot(files, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-domain-words-'));
  const all = {
    'scripts/ci/identifier-domain-words.json': JSON.stringify({ scan: ['src/ids'], words: ['alpha', 'beta'], phrases: ['甲乙'], allow: [], ...config }),
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

test('the repository passes', () => {
  const result = checkIdentifierDomainWords();
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.problems, []);
  assert.ok(result.scanned >= 4);
});

test('splits identifiers at case changes and separators', () => {
  assert.deepEqual(wordsOf('AlphaId ALPHA_SHAPE isBetaCode HTTPAlpha').map((w) => w.word), ['alpha', 'id', 'alpha', 'shape', 'is', 'beta', 'code', 'http', 'alpha']);
});

test('flags a domain word in a type name, a constant, a comment and a phrase', () => {
  const root = makeRoot({ 'src/ids/a.ts': "// beta numbers\nexport type AlphaKind = 'x';\nconst BETA_CUE = /甲乙/u;\n", 'src/other/b.ts': 'const alpha = 1;\n' });
  const result = checkIdentifierDomainWords(root);
  assert.deepEqual(
    result.violations.map((v) => `${v.file}:${v.line}:${v.word}`),
    ['src/ids/a.ts:1:beta', 'src/ids/a.ts:2:alpha', 'src/ids/a.ts:3:beta', 'src/ids/a.ts:3:甲乙'],
  );
});

test('an allowed text is skipped, and a stale or unreasoned entry is a problem', () => {
  const allow = [
    { path: 'src/ids/a.ts', text: "'alpha_x'", reason: 'contract value' },
    { path: 'src/ids/a.ts', text: 'gone', reason: 'stale' },
    { path: 'src/ids/a.ts', text: 'shape', reason: '' },
  ];
  const result = checkIdentifierDomainWords(makeRoot({ 'src/ids/a.ts': "const shape = 'alpha_x';\n" }, { allow }));
  assert.deepEqual(result.violations, []);
  assert.equal(result.problems.length, 2);
});
