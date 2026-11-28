import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../../eval/harness/corpus.mts';
import { runDupPairs } from '../../eval/harness/run-dup-pairs.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAIR_KEYS = ['chunk_a', 'chunk_b', 'cosine', 'embedding_profile_id', 'hamming', 'same_template', 'tenant'];

const PASSAGE = Array.from({ length: 60 }, (_, i) => `vorel${i} quandit${(i * 7) % 61} sabrune${(i * 3) % 59}`).join(' ');
const TEMPLATE = [
  '<!-- fixture-meta {"generate": {"count": 2, "name": "twin-{n}.en.md", "substitutions": [["vorel3", "vorel3"]], "template_id": "TW"}} -->',
  '## Shared passage',
  '',
  PASSAGE,
  '',
].join('\n');
const OTHER = `## Unrelated\n\n${Array.from({ length: 60 }, (_, i) => `plindor${i} maskevo${(i * 5) % 53}`).join(' ')}\n`;
const MARKER = 'vorel17';

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-pairs-'));
  tempDirs.push(dir);
  return dir;
}

function corpus(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'en'));
  fs.writeFileSync(path.join(dir, 'en/twin-template.en.md'), TEMPLATE);
  fs.writeFileSync(path.join(dir, 'en/unrelated.en.md'), OTHER);
  return dir;
}

describe('run-dup-pairs harness (04.2-16)', () => {
  test('lists candidate pairs with ids and numbers, labelling the template copies', async () => {
    const dir = corpus();
    const loaded = loadCorpus(dir);
    const twins = loaded.documents.filter((doc) => doc.fixtureDupTemplate === 'TW');
    assert.equal(twins.length, 2);
    const sharedIds = new Set(twins.map((doc) => doc.chunks[0]!.id));
    const pairs = await runDupPairs({ corpusDir: dir, deploymentMode: 'single-tenant' });
    assert.ok(pairs.length >= 1, `pairs: ${JSON.stringify(pairs)}`);
    for (const pair of pairs) {
      assert.deepEqual(Object.keys(pair).sort(), PAIR_KEYS);
      assert.equal(pair.tenant, 's:default');
      assert.ok(pair.chunk_a < pair.chunk_b, 'pairs are unordered and listed once');
      assert.ok(!JSON.stringify(pair).includes(MARKER), 'no chunk text in a pair line');
    }
    const twinPair = pairs.find((pair) => sharedIds.has(pair.chunk_a) && sharedIds.has(pair.chunk_b));
    assert.ok(twinPair, `no pair between the two template copies: ${JSON.stringify(pairs)}`);
    assert.equal(twinPair.same_template, true);
    assert.equal(typeof twinPair.cosine, 'number');
    assert.equal(typeof twinPair.hamming, 'number');
    const keys = new Set(pairs.map((pair) => `${pair.chunk_a}:${pair.chunk_b}`));
    assert.equal(keys.size, pairs.length);
    const unrelated = loaded.documents.find((doc) => doc.relpath === 'en/unrelated.en.md')!;
    const unrelatedIds = new Set(unrelated.chunks.map((chunk) => chunk.id));
    for (const pair of pairs.filter((p) => unrelatedIds.has(p.chunk_a) || unrelatedIds.has(p.chunk_b))) {
      assert.equal(pair.same_template, false);
    }
  });

  test('the command line writes JSON lines without chunk text', () => {
    const dir = corpus();
    const out = path.join(tempDir(), 'pairs.jsonl');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'eval/harness/run-dup-pairs.mts', '--corpus', dir, '--deployment-mode', 'multi-tenant', '--out', out],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    assert.ok(!text.includes(MARKER));
    const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(lines.length >= 1);
    assert.ok(lines.some((line) => line.same_template === true));
    for (const line of lines) assert.match(String(line.tenant), /^u:/);
  });
});
