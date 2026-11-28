import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLanguageLiterals, findLiterals, isExempt } from '../ci/check-language-literals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-language-literals.mjs');
const REGISTRY = fs.readFileSync(path.join(ROOT, 'config', 'rag', 'language-packs.json'), 'utf8');
const ALLOWLIST = 'scripts/ci/language-literal-allowlist.json';

function makeRoot(files, { allowlist = null, registry = REGISTRY } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-literals-'));
  const all = { 'config/rag/language-packs.json': registry, ...files };
  if (allowlist) all[ALLOWLIST] = JSON.stringify({ entries: allowlist });
  for (const [rel, text] of Object.entries(all)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

const flagged = (files, options) => checkLanguageLiterals(makeRoot(files, options)).violations.map((v) => v.file);
const problems = (files, options) => checkLanguageLiterals(makeRoot(files, options)).problems;

test('a TypeScript union of the three codes in any order fails', () => {
  assert.deepEqual(flagged({ 'src/x.ts': "type L = 'en' | 'zh' | 'it';\n" }), ['src/x.ts']);
});

test('a TypeScript const tuple fails', () => {
  assert.deepEqual(flagged({ 'src/y.ts': "export const L = ['zh', 'en', 'it'] as const;\n" }), ['src/y.ts']);
});

test('a JavaScript array across lines fails', () => {
  assert.deepEqual(flagged({ 'scripts/z.js': "const L = [\n  'it',\n  'en',\n  'zh',\n];\n" }), ['scripts/z.js']);
});

test('a Python Literal in another order fails', () => {
  assert.deepEqual(flagged({ 'rag-sidecar/src/m.py': 'L = Literal["it", "zh", "en"]\n' }), ['rag-sidecar/src/m.py']);
});

test('a Python tuple fails, and a union with an extra value fails too', () => {
  assert.deepEqual(flagged({ 'eval/src/a.py': 'L = ("zh", "en", "it")\n' }), ['eval/src/a.py']);
  assert.deepEqual(flagged({ 'eval/src/b.py': 'L = Literal["zh", "en", "it", "any"]\n' }), ['eval/src/b.py']);
});

test('one or two codes, or the codes in prose or a map, pass', () => {
  const files = {
    'src/one.ts': "const a = 'zh';\nconst b = ['en', 'it'];\n",
    'src/map.ts': "const m = { zh: 'Chinese', en: 'English', it: 'Italian' };\n",
    'src/mapq.ts': "const m = { 'zh': 1, 'en': 2, 'it': 3 };\n",
    'src/prose.ts': "// supports zh, en, it\nconst s = 'zh en it';\n",
    'rag-sidecar/src/p.py': 'X = {"zh": 1, "en": 2, "it": 3}\n',
  };
  assert.deepEqual(flagged(files), []);
});

test('tests, fixtures, generated files and unscanned roots are exempt', () => {
  const literal = "type L = 'zh' | 'en' | 'it';\n";
  const files = {
    'src/lib/tests/x.ts': literal,
    'src/__tests__/x.ts': literal,
    'eval/src/fixtures/x.py': 'L = ("zh", "en", "it")\n',
    'src/lib/rag-eval/contracts.generated.ts': literal,
    'scripts/tests/x.mjs': literal,
    'voice-agent/src/x.ts': literal,
    'src/x.md': literal,
  };
  assert.deepEqual(flagged(files), []);
  assert.equal(isExempt('rag-sidecar/schemas/GoldenItem.schema.json'), true);
  assert.equal(isExempt('src/lib/rag/query/filters.ts'), false);
});

test('the codes are read from the registry, not from the script', () => {
  const registry = JSON.stringify({ schema_version: 1, packs: [{ code: 'aa' }, { code: 'bb' }] });
  assert.deepEqual(flagged({ 'src/x.ts': "type L = 'bb' | 'aa';\n", 'src/y.ts': "type L = 'zh' | 'en' | 'it';\n" }, { registry }), [
    'src/x.ts',
  ]);
  assert.deepEqual(findLiterals("['zh', 'en']", ['zh', 'en', 'it']), []);
});

test('an allow-listed file passes', () => {
  const files = { 'src/x.ts': "type L = 'zh' | 'en' | 'it';\n" };
  const allowlist = [{ path: 'src/x.ts', owner: '03.2-11', reason: 'converted later' }];
  assert.deepEqual(flagged(files, { allowlist }), []);
  assert.deepEqual(problems(files, { allowlist }), []);
});

test('an allow-list entry without owner fails with its path', () => {
  const files = { 'src/x.ts': "type L = 'zh' | 'en' | 'it';\n" };
  const found = problems(files, { allowlist: [{ path: 'src/x.ts', reason: 'no owner' }] });
  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/x\.ts: owner/);
});

test('an allow-list entry without reason fails', () => {
  const files = { 'src/x.ts': "type L = 'zh' | 'en' | 'it';\n" };
  assert.match(problems(files, { allowlist: [{ path: 'src/x.ts', owner: '03.2-11' }] })[0], /reason/);
});

test('an entry for a file with no literal fails as stale', () => {
  const files = { 'src/clean.ts': "const a = 'zh';\n" };
  const found = problems(files, { allowlist: [{ path: 'src/clean.ts', owner: '03.2-11', reason: 'r' }] });
  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/clean\.ts: stale/);
});

test('an entry naming a missing file fails', () => {
  const found = problems({}, { allowlist: [{ path: 'src/gone.ts', owner: '03.2-11', reason: 'r' }] });
  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/gone\.ts: file does not exist/);
});

test('the CLI exits 1 on a literal and 0 on a clean tree', () => {
  const dirty = makeRoot({ 'src/x.ts': "type L = 'zh' | 'en' | 'it';\n" });
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', dirty], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /src\/x\.ts:1 hard-coded language codes/);

  const clean = makeRoot({ 'src/x.ts': "const a = 'zh';\n" });
  const good = spawnSync(process.execPath, [SCRIPT, '--root', clean], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /0 allow-listed file\(s\)/);
});

test('the repository tree passes and reports its allow-listed files', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, run.stderr);
  const count = JSON.parse(fs.readFileSync(path.join(ROOT, ALLOWLIST), 'utf8')).entries.length;
  assert.match(run.stdout, new RegExp(`${count} allow-listed file\\(s\\)`));
});
