import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'check-config.mjs');
const TRACKED = [
  'scripts/init-env.js',
  'src/lib/env.ts',
  'scripts/config-server.js',
  'scripts/config-ui/index.html',
];
const MANIFEST = 'scripts/rag/env-manifest.json';

function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function write(root, relative, text) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function copyRealTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-config-'));
  for (const relative of [...TRACKED, MANIFEST]) {
    write(root, relative, fs.readFileSync(path.join(REPO, relative), 'utf8'));
  }
  return root;
}

function syntheticTree({ files = {}, manifest }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-config-syn-'));
  for (const relative of TRACKED) write(root, relative, files[relative] ?? '');
  write(root, MANIFEST, JSON.stringify(manifest, null, 2));
  return root;
}

function editManifest(root, edit) {
  const file = path.join(root, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test('passes on the real tree', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('passes on a copy of the tracked files and does not require .env.local', () => {
  const root = copyRealTree();
  try {
    assert.equal(fs.existsSync(path.join(root, '.env.local')), false);
    const { code, out } = run(root);
    assert.equal(code, 0, out);
  } finally {
    cleanup(root);
  }
});

test('fails and names the variable and location when a managed variable is deleted from config-server', () => {
  const root = copyRealTree();
  try {
    const file = path.join(root, 'scripts/config-server.js');
    const text = fs.readFileSync(file, 'utf8').replace(/RAG_EVAL_SECRET/g, 'REMOVED');
    fs.writeFileSync(file, text);
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_EVAL_SECRET \[config-server\]/);
  } finally {
    cleanup(root);
  }
});

test('fails when a knownGaps entry is no longer a gap', () => {
  const root = copyRealTree();
  try {
    editManifest(root, (m) => {
      const entry = m.vars.find((v) => v.name === 'RAG_BEHAVIOR_MODE');
      entry.knownGaps = ['init-env'];
    });
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_BEHAVIOR_MODE \[init-env\] .*knownGaps/);
  } finally {
    cleanup(root);
  }
});

test('fails when src reads a RAG variable that is not in the manifest', () => {
  const root = copyRealTree();
  try {
    write(root, 'src/lib/probe.ts', 'export const probe = process.env.RAG_NOT_IN_MANIFEST;\n');
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_NOT_IN_MANIFEST \[manifest\]/);
  } finally {
    cleanup(root);
  }
});

test('fails when a managed variable lists knownGaps', () => {
  const root = copyRealTree();
  try {
    editManifest(root, (m) => {
      const entry = m.vars.find((v) => v.name === 'RAG_EVAL_SECRET');
      entry.knownGaps = ['config-ui'];
    });
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_EVAL_SECRET \[manifest\] managed variable must not list knownGaps/);
  } finally {
    cleanup(root);
  }
});

test('treats RAG_RERANKING and RAG_RERANKING_STRATEGY as distinct names', () => {
  const root = syntheticTree({
    files: Object.fromEntries(TRACKED.map((f) => [f, 'RAG_RERANKING_STRATEGY=hybrid\n'])),
    manifest: {
      schemaVersion: 1,
      vars: [
        { name: 'RAG_RERANKING', status: 'managed', knownGaps: [] },
        { name: 'RAG_RERANKING_STRATEGY', status: 'managed', knownGaps: [] },
      ],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1);
    for (const location of ['config-server', 'config-ui', 'env-ts', 'init-env']) {
      assert.match(out, new RegExp(`RAG_RERANKING \\[${location}\\] missing`));
    }
    assert.doesNotMatch(out, /RAG_RERANKING_STRATEGY \[/);
  } finally {
    cleanup(root);
  }
});

test('treats NEXT_PUBLIC_RAG_CACHE_ENABLED and RAG_CACHE_ENABLED as distinct names', () => {
  const root = syntheticTree({
    files: Object.fromEntries(TRACKED.map((f) => [f, 'NEXT_PUBLIC_RAG_CACHE_ENABLED=true\n'])),
    manifest: {
      schemaVersion: 1,
      vars: [
        { name: 'NEXT_PUBLIC_RAG_CACHE_ENABLED', status: 'managed', knownGaps: [] },
        { name: 'RAG_CACHE_ENABLED', status: 'managed', knownGaps: [] },
      ],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_CACHE_ENABLED \[init-env\] missing/);
    assert.doesNotMatch(out, /NEXT_PUBLIC_RAG_CACHE_ENABLED \[/);
  } finally {
    cleanup(root);
  }
});

test('fails when a tracked location file is missing', () => {
  const root = copyRealTree();
  try {
    fs.rmSync(path.join(root, 'scripts/config-ui/index.html'));
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /\[config-ui\] tracked file scripts\/config-ui\/index\.html is missing/);
  } finally {
    cleanup(root);
  }
});

test('fails when the manifest lists zero variables', () => {
  const root = copyRealTree();
  try {
    editManifest(root, (m) => {
      m.vars = [];
    });
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /manifest lists zero variables/);
  } finally {
    cleanup(root);
  }
});

test('fails when the manifest lists a name twice', () => {
  const root = copyRealTree();
  try {
    editManifest(root, (m) => {
      m.vars.push({ ...m.vars.find((v) => v.name === 'RAG_BEHAVIOR_MODE') });
    });
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_BEHAVIOR_MODE \[manifest\] listed more than once/);
  } finally {
    cleanup(root);
  }
});

test('checks managed variables against .env.local only when the file exists', () => {
  const root = copyRealTree();
  try {
    write(root, '.env.local', 'RAG_EVAL_ENDPOINT_ENABLED=false\n');
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /RAG_EVAL_SECRET \[env-local\] .*npm run config/);
    assert.doesNotMatch(out, /RAG_EVAL_ENDPOINT_ENABLED \[env-local\]/);
  } finally {
    cleanup(root);
  }
});

test('prints violations sorted by variable name then location', () => {
  const root = syntheticTree({
    manifest: {
      schemaVersion: 1,
      vars: [
        { name: 'RAG_ZETA', status: 'managed', knownGaps: [] },
        { name: 'RAG_ALPHA', status: 'managed', knownGaps: [] },
      ],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1);
    const lines = out.split('\n').filter((line) => /^RAG_[A-Z]+ \[/.test(line));
    const keys = lines.map((line) => line.match(/^(\S+) \[([^\]]+)\]/).slice(1, 3).join(' '));
    assert.equal(keys.length, 8);
    assert.deepEqual(keys, [...keys].sort());
    assert.ok(keys[0].startsWith('RAG_ALPHA config-server'));
    assert.ok(keys[7].startsWith('RAG_ZETA init-env'));
  } finally {
    cleanup(root);
  }
});

test('fails when src reads a LANGFUSE variable that is not in the manifest', () => {
  const root = syntheticTree({
    files: { 'scripts/init-env.js': 'LANGFUSE_BASE_URL=https://example.invalid\n' },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    write(root, 'src/lib/probe.ts', 'export const probe = process.env.LANGFUSE_SAMPLE_RATE;\n');
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /LANGFUSE_SAMPLE_RATE \[manifest\] used in src\/ or a tracked file but not in the manifest/);
    assert.match(out, /LANGFUSE_BASE_URL \[manifest\] used in src\/ or a tracked file but not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('fails when a managed LANGFUSE variable is missing from config-ui', () => {
  const present = 'LANGFUSE_PUBLIC_KEY=\n';
  const root = syntheticTree({
    files: {
      'scripts/init-env.js': present,
      'src/lib/env.ts': present,
      'scripts/config-server.js': present,
    },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'LANGFUSE_PUBLIC_KEY', status: 'managed', knownGaps: [] }],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /LANGFUSE_PUBLIC_KEY \[config-ui\] missing from this location/);
    assert.doesNotMatch(out, /not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('fails when a tracked file declares a VOYAGE variable that is not in the manifest', () => {
  const root = syntheticTree({
    files: { 'src/lib/env.ts': "VOYAGE_API_KEY: process.env.VOYAGE_API_KEY || '',\n" },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /VOYAGE_API_KEY \[manifest\] used in src\/ or a tracked file but not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('fails when src reads a DEEPINFRA variable that is not in the manifest', () => {
  const root = syntheticTree({
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    write(root, 'src/lib/probe.ts', 'export const probe = process.env.DEEPINFRA_BASE_URL;\n');
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /DEEPINFRA_BASE_URL \[manifest\] used in src\/ or a tracked file but not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('reports a managed VOYAGE variable missing from init-env while present in env.ts', () => {
  const root = syntheticTree({
    files: {
      'src/lib/env.ts': 'VOYAGE_API_KEY=\n',
      'scripts/config-server.js': 'VOYAGE_API_KEY=\n',
      'scripts/config-ui/index.html': 'VOYAGE_API_KEY=\n',
    },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'VOYAGE_API_KEY', status: 'managed', knownGaps: [] }],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /VOYAGE_API_KEY \[init-env\] missing from this location/);
    assert.doesNotMatch(out, /not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('fails when RAG_PARSE_ROUTING=tiered with legacy pipeline', () => {
  const root = copyRealTree();
  try {
    const base = fs.readFileSync(path.join(REPO, 'scripts/init-env.js'), 'utf8');
    write(root, '.env.local', `${base}\nRAG_PARSE_ROUTING=tiered\nRAG_INGEST_PIPELINE=legacy\n`);
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /D-10.*tiered.*unified/i);
    assert.doesNotMatch(out, /llx-/);
  } finally {
    cleanup(root);
  }
});

test('fails when RAG_INGEST_ASYNC=on with legacy pipeline', () => {
  const root = copyRealTree();
  try {
    const base = fs.readFileSync(path.join(REPO, 'scripts/init-env.js'), 'utf8');
    write(root, '.env.local', `${base}\nRAG_INGEST_ASYNC=on\nRAG_INGEST_PIPELINE=legacy\n`);
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /D-22.*RAG_INGEST_ASYNC=on.*unified/i);
  } finally {
    cleanup(root);
  }
});

test('warns on cloud-off with legacy when Llama key is set, without printing the key', () => {
  const root = copyRealTree();
  try {
    const base = fs.readFileSync(path.join(REPO, 'scripts/init-env.js'), 'utf8');
    write(
      root,
      '.env.local',
      `${base}\nRAG_PARSER_ALLOW_CLOUD=false\nRAG_INGEST_PIPELINE=legacy\nLLAMA_CLOUD_API_KEY=llx-test-placeholder-not-real\n`,
    );
    const { code, out } = run(root);
    assert.equal(code, 0, out);
    assert.match(out, /A-2.*LLAMA_CLOUD_API_KEY is set/i);
    assert.doesNotMatch(out, /llx-test-placeholder/);
  } finally {
    cleanup(root);
  }
});

test('fails when COHERE_BASE_URL is missing from the config UI', () => {
  const root = copyRealTree();
  try {
    const file = path.join(root, 'scripts/config-ui/index.html');
    const text = fs.readFileSync(file, 'utf8').replace(/COHERE_BASE_URL/g, 'REMOVED_COHERE_BASE_URL');
    fs.writeFileSync(file, text);
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /COHERE_BASE_URL \[config-ui\]/);
  } finally {
    cleanup(root);
  }
});

test('does not treat VOYAGER_* or a VOYAGE name without the underscore as a provider variable', () => {
  const root = syntheticTree({
    files: { 'scripts/init-env.js': 'VOYAGER_X=1\nVOYAGEX=2\nXVOYAGE_KEY=3\nDEEPINFRAX=4\n' },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 0, out);
  } finally {
    cleanup(root);
  }
});

test('cloud-off warning covers every value the runtime refuses, and not the allowed ones', async () => {
  const { checkIngestionSwitches } = await import('./check-config.mjs');
  const warns = (value) =>
    checkIngestionSwitches({
      RAG_PARSER_ALLOW_CLOUD: value,
      RAG_INGEST_PIPELINE: 'legacy',
      LLAMA_CLOUD_API_KEY: 'llx-test-placeholder-not-real',
    }).warnings.length;
  for (const value of ['false', '0', 'off', 'no', 'disabled', 'maybe']) assert.equal(warns(value), 1, value);
  for (const value of ['true', '1', 'yes', 'on', 'ON', '']) assert.equal(warns(value), 0, value);
});

test('fails when src reads an ANTHROPIC variable that is not in the manifest', () => {
  const root = syntheticTree({
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    write(root, 'src/lib/probe.ts', 'export const probe = process.env.ANTHROPIC_API_KEY;\n');
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /ANTHROPIC_API_KEY \[manifest\] used in src\/ or a tracked file but not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('fails when a managed ANTHROPIC variable is missing from config-ui', () => {
  const present = 'ANTHROPIC_API_KEY=\n';
  const root = syntheticTree({
    files: {
      'scripts/init-env.js': present,
      'src/lib/env.ts': present,
      'scripts/config-server.js': present,
    },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    const first = run(root);
    assert.equal(first.code, 1);
    assert.match(first.out, /ANTHROPIC_API_KEY \[manifest\] used in src\/ or a tracked file but not in the manifest/);
    editManifest(root, (manifest) => {
      manifest.vars = [{ name: 'ANTHROPIC_API_KEY', status: 'managed', knownGaps: [] }];
    });
    const { code, out } = run(root);
    assert.equal(code, 1);
    assert.match(out, /ANTHROPIC_API_KEY \[config-ui\] missing from this location/);
    assert.doesNotMatch(out, /not in the manifest/);
  } finally {
    cleanup(root);
  }
});

test('does not discover an ANTHROPIC name embedded in a longer identifier', () => {
  const root = syntheticTree({
    files: { 'scripts/init-env.js': 'MY_ANTHROPIC_API_KEY_X=1\nXANTHROPIC_KEY=2\n' },
    manifest: {
      schemaVersion: 1,
      vars: [{ name: 'RAG_PLACEHOLDER', status: 'legacy', knownGaps: ['config-server', 'config-ui', 'env-ts', 'init-env'] }],
    },
  });
  try {
    write(root, 'src/lib/probe.ts', 'export const probe = process.env.MY_ANTHROPIC_API_KEY_X;\n');
    const { code, out } = run(root);
    assert.equal(code, 0, out);
  } finally {
    cleanup(root);
  }
});

const OPUS_JSON = '{"id":"anthropic/claude-opus-4.1","displayName":"Claude Opus 4.1"}';
const OPUS_LITERAL = "{ id: 'anthropic/claude-opus-4.1', displayName: 'Claude Opus 4.1' },";
const TEST_MODEL = 'anthropic/claude-test-9';

function jsonEntry(id, anthropicId) {
  const entry = { id, displayName: 'Test Model 9' };
  if (anthropicId !== null) entry.anthropicId = anthropicId;
  return JSON.stringify(entry);
}

function literalEntry(id, anthropicId) {
  const mapped = anthropicId === null ? '' : `, anthropicId: '${anthropicId}'`;
  return `{ id: '${id}', displayName: 'Test Model 9'${mapped} },`;
}

function replaceNth(text, needle, nth, replacement) {
  let index = -1;
  for (let i = 0; i <= nth; i += 1) {
    index = text.indexOf(needle, index + 1);
    assert.notEqual(index, -1, `anchor ${needle} occurrence ${nth} not found`);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

/** plan: location -> anthropicId (string), null (entry without anthropicId) or undefined (no entry); config-ui takes an array of three. */
function injectModel(root, id, plan) {
  const edit = (relative, fn) => {
    const file = path.join(root, relative);
    fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
  };
  for (const [location, relative] of [['init-env', 'scripts/init-env.js'], ['config-server', 'scripts/config-server.js']]) {
    if (plan[location] === undefined) continue;
    edit(relative, (text) => replaceNth(text, OPUS_JSON, 0, `${OPUS_JSON},${jsonEntry(id, plan[location])}`));
  }
  if (plan['env-ts'] !== undefined) {
    edit('src/lib/env.ts', (text) => replaceNth(text, OPUS_LITERAL, 0, `${OPUS_LITERAL} ${literalEntry(id, plan['env-ts'])}`));
  }
  const ui = plan['config-ui'] ?? [];
  edit('scripts/config-ui/index.html', (text) => {
    let out = text;
    for (let nth = 2; nth >= 0; nth -= 1) {
      if (ui[nth] === undefined) continue;
      out = replaceNth(out, OPUS_LITERAL, nth, `${OPUS_LITERAL} ${literalEntry(id, ui[nth])}`);
    }
    return out;
  });
}

const everywhere = (anthropicId) => ({
  'init-env': anthropicId,
  'config-server': anthropicId,
  'env-ts': anthropicId,
  'config-ui': [anthropicId, anthropicId, anthropicId],
});

test('accepts a model mapped to the same anthropicId in every location', () => {
  const root = copyRealTree();
  try {
    injectModel(root, TEST_MODEL, everywhere('claude-test-9'));
    const { code, out } = run(root);
    assert.equal(code, 0, out);
  } finally {
    cleanup(root);
  }
});

test('fails and names both locations when an anthropicId differs between env.ts and init-env', () => {
  const root = copyRealTree();
  try {
    injectModel(root, TEST_MODEL, { ...everywhere('claude-sonnet-5-5'), 'init-env': 'claude-sonnet-5' });
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /anthropic\/claude-test-9 \[init-env\] .*anthropicId/);
    assert.match(out, /env-ts=claude-sonnet-5-5/);
    assert.match(out, /init-env=claude-sonnet-5\b/);
  } finally {
    cleanup(root);
  }
});

test('fails for config-ui when a mapped model is missing from one of the three fallback arrays', () => {
  const root = copyRealTree();
  try {
    const plan = everywhere('claude-test-9');
    plan['config-ui'] = ['claude-test-9', undefined, 'claude-test-9'];
    injectModel(root, TEST_MODEL, plan);
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /anthropic\/claude-test-9 \[config-ui\] .*fallback array 2 of 3/);
  } finally {
    cleanup(root);
  }
});

test('fails when a location lists the mapped model without an anthropicId', () => {
  const root = copyRealTree();
  try {
    injectModel(root, TEST_MODEL, { ...everywhere('claude-test-9'), 'config-server': null });
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /anthropic\/claude-test-9 \[config-server\] .*without anthropicId/);
  } finally {
    cleanup(root);
  }
});

test('fails when an anthropicId does not look like an Anthropic model id', () => {
  const root = copyRealTree();
  try {
    injectModel(root, TEST_MODEL, everywhere('gpt-4'));
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /anthropic\/claude-test-9 \[env-ts\] .*anthropicId "gpt-4" does not match/);
  } finally {
    cleanup(root);
  }
});

test('fails when a model outside anthropic/ carries an anthropicId', () => {
  const root = copyRealTree();
  try {
    injectModel(root, 'openai/gpt-test', everywhere('claude-test-9'));
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /openai\/gpt-test \[env-ts\] .*only anthropic\/ models/);
  } finally {
    cleanup(root);
  }
});

test('compares the .env.local model list only when .env.local exists', () => {
  const root = copyRealTree();
  try {
    injectModel(root, TEST_MODEL, everywhere('claude-test-9'));
    const mapped = `[{"id":"anthropic/claude-sonnet-4.5","displayName":"Claude Sonnet 4.5","isDefault":true},${jsonEntry(TEST_MODEL, 'claude-test-9')}]`;
    write(root, '.env.local', `NEXT_PUBLIC_OPENROUTER_MODELS=${mapped}\n`);
    let { out } = run(root);
    assert.doesNotMatch(out, /claude-test-9 \[env-local\]/);

    write(root, '.env.local', `NEXT_PUBLIC_OPENROUTER_MODELS='${mapped.replace('claude-test-9"}', 'claude-test-8"}')}'\n`);
    ({ out } = run(root));
    assert.match(out, /anthropic\/claude-test-9 \[env-local\] .*env-local=claude-test-8/);

    write(root, '.env.local', 'NEXT_PUBLIC_OPENROUTER_MODELS=[{"id":"anthropic/claude-sonnet-4.5","displayName":"Claude Sonnet 4.5"}]\n');
    ({ out } = run(root));
    assert.match(out, /anthropic\/claude-test-9 \[env-local\] .*missing/);

    write(root, '.env.local', 'RAG_EVAL_ENDPOINT_ENABLED=false\n');
    ({ out } = run(root));
    assert.doesNotMatch(out, /claude-test-9 \[env-local\]/);

    write(root, '.env.local', 'NEXT_PUBLIC_OPENROUTER_MODELS=\n');
    ({ out } = run(root));
    assert.doesNotMatch(out, /claude-test-9 \[env-local\]/);
  } finally {
    cleanup(root);
  }
});

const PHASE6_NAMES = [
  'RAG_QUERY_LAYER',
  'RAG_QUERY_FRAMEWORK',
  'RAG_QUERY_LLM_MODEL',
  'RAG_QUERY_CONDENSE',
  'RAG_QUERY_EXPAND',
  'RAG_QUERY_DECOMPOSE',
  'RAG_QUERY_TRANSLATE',
  'RAG_QUERY_DATE_NORMALIZE',
  'RAG_QUERY_HYDE',
  'RAG_QUERY_TRANSLATE_DISABLED_PROFILES',
  'RAG_QUERY_VOICE_TRANSFORMS',
  'RAG_SEMANTIC_CACHE',
  'RAG_SEMANTIC_CACHE_TTL',
  'RAG_SEMANTIC_CACHE_REFUSAL_TTL',
  'RAG_SEMANTIC_CACHE_MAX_DISTANCE',
  'RAG_SEMANTIC_CACHE_EMBED_STORE',
  'REDIS_URL',
];

function removeName(root, relative, name) {
  const file = path.join(root, relative);
  const text = fs.readFileSync(file, 'utf8').replace(new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`, 'g'), 'REMOVED_NAME');
  fs.writeFileSync(file, text);
}

test('fails and names the location when RAG_QUERY_LAYER is missing from the config UI', () => {
  const root = copyRealTree();
  try {
    removeName(root, 'scripts/config-ui/index.html', 'RAG_QUERY_LAYER');
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /RAG_QUERY_LAYER \[config-ui\] missing from this location/);
  } finally {
    cleanup(root);
  }
});

test('fails when RAG_SEMANTIC_CACHE_EMBED_STORE is missing from the config-server templates', () => {
  const root = copyRealTree();
  try {
    removeName(root, 'scripts/config-server.js', 'RAG_SEMANTIC_CACHE_EMBED_STORE');
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /RAG_SEMANTIC_CACHE_EMBED_STORE \[config-server\] missing from this location/);
  } finally {
    cleanup(root);
  }
});

test('fails when REDIS_URL is missing from env.ts, although its name is outside the discovery pattern', () => {
  const root = copyRealTree();
  try {
    removeName(root, 'src/lib/env.ts', 'REDIS_URL');
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /REDIS_URL \[env-ts\] missing from this location/);
  } finally {
    cleanup(root);
  }
});

test('the manifest lists the Phase 6 names as managed and keeps the legacy query and cache names legacy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST), 'utf8'));
  const byName = new Map(manifest.vars.map((entry) => [entry.name, entry]));
  for (const name of PHASE6_NAMES) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} is not in the manifest`);
    assert.equal(entry.status, 'managed', name);
    assert.deepEqual(entry.knownGaps, [], name);
  }
  for (const name of ['RAG_QUERY_ENHANCEMENT', 'NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED', 'RAG_CACHE_ENABLED', 'NEXT_PUBLIC_RAG_CACHE_ENABLED', 'NEXT_PUBLIC_RAG_CACHE_TTL']) {
    assert.equal(byName.get(name)?.status, 'legacy', name);
  }
});

test('each of the three config-server templates writes every Phase 6 name', () => {
  const text = fs.readFileSync(path.join(REPO, 'scripts/config-server.js'), 'utf8');
  const standard = text.slice(text.indexOf('function getStandardTemplate()'), text.indexOf('function getFullTemplate()'));
  const full = text.slice(text.indexOf('function getFullTemplate()'), text.indexOf('async function checkAdminUsers()'));
  const saved = text.slice(0, text.indexOf('function getMinimalTemplate()'));
  for (const [label, block] of [['save', saved], ['standard', standard], ['full', full]]) {
    for (const name of PHASE6_NAMES) {
      assert.match(block, new RegExp(`^\\$?\\{?[^\\n]*(?<![A-Z0-9_])${name}=`, 'm'), `${name} missing from the ${label} template`);
    }
  }
});

function templateBlocks(text) {
  return [
    ['save', text.slice(0, text.indexOf('function getMinimalTemplate()'))],
    ['standard', text.slice(text.indexOf('function getStandardTemplate()'), text.indexOf('function getFullTemplate()'))],
    ['full', text.slice(text.indexOf('function getFullTemplate()'), text.indexOf('async function checkAdminUsers()'))],
  ];
}

function templatesMissing(text, name) {
  const line = new RegExp(`^\\$?\\{?[^\\n]*(?<![A-Z0-9_])${name}=`, 'm');
  return templateBlocks(text).filter(([, block]) => !line.test(block)).map(([label]) => label);
}

test('refusal floor in every template', () => {
  const text = fs.readFileSync(path.join(REPO, 'scripts/config-server.js'), 'utf8');
  assert.deepEqual(templatesMissing(text, 'RAG_REFUSAL_FLOOR'), []);
  for (const [label, block] of templateBlocks(text)) {
    assert.match(block, /RAG_REFUSAL_FLOOR[^\n]*'similarity'|RAG_REFUSAL_FLOOR=similarity/, `${label} template does not default to similarity`);
  }
  const [, standard] = templateBlocks(text)[1];
  const withoutStandard = text.replace(standard, standard.replace(/^RAG_REFUSAL_FLOOR=.*\n/m, ''));
  assert.deepEqual(templatesMissing(withoutStandard, 'RAG_REFUSAL_FLOOR'), ['standard']);

  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST), 'utf8'));
  const entry = manifest.vars.find((v) => v.name === 'RAG_REFUSAL_FLOOR');
  assert.equal(entry?.status, 'managed');
  assert.deepEqual(entry?.knownGaps, []);

  const root = copyRealTree();
  try {
    removeName(root, 'scripts/config-server.js', 'RAG_REFUSAL_FLOOR');
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /RAG_REFUSAL_FLOOR \[config-server\] missing from this location/);
  } finally {
    cleanup(root);
  }
});

test('the reranker option lists name auto and keep none as the default', () => {
  const init = fs.readFileSync(path.join(REPO, 'scripts/init-env.js'), 'utf8');
  assert.match(init, /# Reranker: none \| auto \| cohere \| voyage \| local_bm25/);
  assert.match(init, /^RAG_RERANKER=none$/m);
  assert.match(init, /^RAG_REFUSAL_FLOOR=similarity$/m);
  const env = fs.readFileSync(path.join(REPO, 'src/lib/env.ts'), 'utf8');
  assert.match(env, /RAG_REFUSAL_FLOOR: process\.env\.RAG_REFUSAL_FLOOR \|\| 'similarity'/);
  assert.match(env, /RAG_RERANKER: process\.env\.RAG_RERANKER \|\| 'none'/);
});

const FEEDBACK_LOOP_NAMES = [
  'RAG_RETRIEVAL_LOG',
  'RAG_RETRIEVAL_LOG_RETENTION_DAYS',
  'RAG_REFUSAL_FEEDBACK',
  'RAG_EMBED_FEEDBACK',
  'RAG_EMBED_FEEDBACK_SECRET',
  'RAG_SOURCE_OPEN_SIGNAL',
  'RAG_DOMAIN_EXPERT_REVIEW',
];
const FEEDBACK_LOOP_DEFAULTS = {
  RAG_RETRIEVAL_LOG: 'off',
  RAG_RETRIEVAL_LOG_RETENTION_DAYS: '30',
  RAG_REFUSAL_FEEDBACK: 'false',
  RAG_EMBED_FEEDBACK: 'false',
  RAG_EMBED_FEEDBACK_SECRET: '',
  RAG_SOURCE_OPEN_SIGNAL: 'false',
  RAG_DOMAIN_EXPERT_REVIEW: 'false',
};

test('the manifest lists the seven feedback-loop names as managed (D-26)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST), 'utf8'));
  const byName = new Map(manifest.vars.map((entry) => [entry.name, entry]));
  for (const name of FEEDBACK_LOOP_NAMES) {
    assert.equal(byName.get(name)?.status, 'managed', name);
    assert.deepEqual(byName.get(name)?.knownGaps, [], name);
  }
});

test('fails when any feedback-loop name is removed from any single location', () => {
  for (const name of FEEDBACK_LOOP_NAMES) {
    for (const [relative, location] of [
      ['scripts/init-env.js', 'init-env'],
      ['src/lib/env.ts', 'env-ts'],
      ['scripts/config-server.js', 'config-server'],
      ['scripts/config-ui/index.html', 'config-ui'],
    ]) {
      const root = copyRealTree();
      try {
        removeName(root, relative, name);
        const { code, out } = run(root);
        assert.equal(code, 1, `${name} removed from ${location}: ${out}`);
        assert.match(out, new RegExp(`${name} \\[${location}\\] missing from this location`));
      } finally {
        cleanup(root);
      }
    }
  }
});

test('the feedback-loop defaults match D-26 in init-env, env.ts and all three config-server templates', () => {
  const init = fs.readFileSync(path.join(REPO, 'scripts/init-env.js'), 'utf8');
  const envTs = fs.readFileSync(path.join(REPO, 'src/lib/env.ts'), 'utf8');
  const server = fs.readFileSync(path.join(REPO, 'scripts/config-server.js'), 'utf8');
  for (const [name, value] of Object.entries(FEEDBACK_LOOP_DEFAULTS)) {
    assert.match(init, new RegExp(`^${name}=${value}$`, 'm'), `init-env ${name}`);
    assert.ok(envTs.includes(`${name}: process.env.${name} || '${value}',`), `env.ts ${name}`);
    assert.deepEqual(templatesMissing(server, name), [], `config-server ${name}`);
    for (const [label, block] of templateBlocks(server)) {
      const quoted = `'${name}=${value}'`;
      const fallback = `getEnvValue('${name}') || '${value}'`;
      assert.ok(block.includes(quoted) || block.includes(fallback), `${label} template default for ${name}`);
    }
  }
});

test('the embed feedback secret is masked by the config server and warned on when shorter than 32 characters', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const security = require('./config-server-security.js');
  assert.equal(security.isSecretConfigEntry('RAG_EMBED_FEEDBACK_SECRET', ''), true);
  const masked = security.maskConfig({ RAG_EMBED_FEEDBACK_SECRET: 'placeholder-value', RAG_EMBED_FEEDBACK: 'true' });
  assert.deepEqual(masked.config, { RAG_EMBED_FEEDBACK: 'true' });
  assert.deepEqual(masked.secretsSet, ['RAG_EMBED_FEEDBACK_SECRET']);
  const server = fs.readFileSync(path.join(REPO, 'scripts/config-server.js'), 'utf8');
  const list = server.match(/for \(const name of \[([^\]]*'RAG_EVAL_SECRET'[^\]]*)\]\)/);
  assert.ok(list, 'short-secret warning list exists');
  assert.match(list[1], /'RAG_EMBED_FEEDBACK_SECRET'/);
});

const VECTOR_BACKEND_DEFAULTS = {
  RAG_RETRIEVAL_BACKEND: 'pgvector',
  RAG_RETRIEVAL_BACKEND_VOICE: 'pgvector',
  RAG_VECTOR_SYNC_SECRET: '',
  RAG_VECTOR_SYNC_MAX_LAG_SECONDS: '300',
  WEAVIATE_URL: '',
  WEAVIATE_API_KEY: '',
  WEAVIATE_READ_API_KEY: '',
  QDRANT_URL: '',
  QDRANT_API_KEY: '',
  QDRANT_READ_API_KEY: '',
};
const VECTOR_BACKEND_NAMES = Object.keys(VECTOR_BACKEND_DEFAULTS);
const VECTOR_BACKEND_SECRETS = ['RAG_VECTOR_SYNC_SECRET', 'WEAVIATE_API_KEY', 'WEAVIATE_READ_API_KEY', 'QDRANT_API_KEY', 'QDRANT_READ_API_KEY'];

test('reports exactly the location that lacks a managed RAG_RETRIEVAL_BACKEND in a fixture tree', () => {
  const files = Object.fromEntries(TRACKED.map((f) => [f, 'RAG_RETRIEVAL_BACKEND=pgvector\n']));
  files['scripts/config-ui/index.html'] = '<input id="OTHER_SETTING">\n';
  const root = syntheticTree({
    files,
    manifest: { schemaVersion: 1, vars: [{ name: 'RAG_RETRIEVAL_BACKEND', status: 'managed', knownGaps: [] }] },
  });
  try {
    const { code, out } = run(root);
    assert.equal(code, 1, out);
    assert.match(out, /RAG_RETRIEVAL_BACKEND \[config-ui\] missing from this location/);
    for (const location of ['config-server', 'env-ts', 'init-env']) {
      assert.doesNotMatch(out, new RegExp(`RAG_RETRIEVAL_BACKEND \\[${location}\\]`));
    }
  } finally {
    cleanup(root);
  }
});

test('fails when src reads a QDRANT or WEAVIATE variable that is not in the manifest', () => {
  for (const name of ['QDRANT_COLLECTION_PREFIX', 'WEAVIATE_GRPC_URL']) {
    const root = copyRealTree();
    try {
      write(root, 'src/lib/probe.ts', `export const probe = process.env.${name};\n`);
      const { code, out } = run(root);
      assert.equal(code, 1, out);
      assert.match(out, new RegExp(`${name} \\[manifest\\] used in src/ or a tracked file but not in the manifest`));
    } finally {
      cleanup(root);
    }
  }
});

test('the manifest lists the ten vector-backend names as managed (D-24)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST), 'utf8'));
  const byName = new Map(manifest.vars.map((entry) => [entry.name, entry]));
  for (const name of VECTOR_BACKEND_NAMES) {
    assert.equal(byName.get(name)?.status, 'managed', name);
    assert.deepEqual(byName.get(name)?.knownGaps, [], name);
  }
});

test('fails when any vector-backend name is removed from any single location', () => {
  for (const name of VECTOR_BACKEND_NAMES) {
    for (const [relative, location] of [
      ['scripts/init-env.js', 'init-env'],
      ['src/lib/env.ts', 'env-ts'],
      ['scripts/config-server.js', 'config-server'],
      ['scripts/config-ui/index.html', 'config-ui'],
    ]) {
      const root = copyRealTree();
      try {
        removeName(root, relative, name);
        const { code, out } = run(root);
        assert.equal(code, 1, `${name} removed from ${location}: ${out}`);
        assert.match(out, new RegExp(`${name} \\[${location}\\] missing from this location`));
      } finally {
        cleanup(root);
      }
    }
  }
});

test('the vector-backend defaults match D-24 in init-env, env.ts and all three config-server templates, with empty secrets', () => {
  const init = fs.readFileSync(path.join(REPO, 'scripts/init-env.js'), 'utf8');
  const envTs = fs.readFileSync(path.join(REPO, 'src/lib/env.ts'), 'utf8');
  const server = fs.readFileSync(path.join(REPO, 'scripts/config-server.js'), 'utf8');
  for (const [name, value] of Object.entries(VECTOR_BACKEND_DEFAULTS)) {
    assert.match(init, new RegExp(`^${name}=${value}$`, 'm'), `init-env ${name}`);
    assert.ok(envTs.includes(`${name}: process.env.${name} || '${value}',`), `env.ts ${name}`);
    assert.deepEqual(templatesMissing(server, name), [], `config-server ${name}`);
    for (const [label, block] of templateBlocks(server)) {
      const quoted = `'${name}=${value}'`;
      const fallback = `getEnvValue('${name}') || '${value}'`;
      assert.ok(block.includes(quoted) || block.includes(fallback), `${label} template default for ${name}`);
    }
  }
  for (const name of VECTOR_BACKEND_SECRETS) {
    assert.doesNotMatch(init, new RegExp(`^${name}=.+$`, 'm'), `init-env ${name} must be empty`);
  }
});

test('the vector-backend secrets are masked by the config server and the sync secret is warned on when short', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const security = require('./config-server-security.js');
  for (const name of VECTOR_BACKEND_SECRETS) {
    assert.equal(security.isSecretConfigEntry(name, 'placeholder-value'), true, name);
  }
  for (const name of ['RAG_RETRIEVAL_BACKEND', 'RAG_RETRIEVAL_BACKEND_VOICE', 'RAG_VECTOR_SYNC_MAX_LAG_SECONDS']) {
    assert.equal(security.isSecretConfigEntry(name, 'pgvector'), false, name);
  }
  const server = fs.readFileSync(path.join(REPO, 'scripts/config-server.js'), 'utf8');
  const list = server.match(/for \(const name of \[([^\]]*'RAG_EVAL_SECRET'[^\]]*)\]\)/);
  assert.ok(list, 'short-secret warning list exists');
  assert.match(list[1], /'RAG_VECTOR_SYNC_SECRET'/);
});

test('the config UI offers pgvector, weaviate and qdrant for both backend selects and hides the keys', () => {
  const html = fs.readFileSync(path.join(REPO, 'scripts/config-ui/index.html'), 'utf8');
  for (const name of ['RAG_RETRIEVAL_BACKEND', 'RAG_RETRIEVAL_BACKEND_VOICE']) {
    const select = html.match(new RegExp(`<select id="${name}"[\\s\\S]*?</select>`));
    assert.ok(select, `${name} select`);
    for (const option of ['pgvector', 'weaviate', 'qdrant']) assert.match(select[0], new RegExp(`value="${option}"`), `${name} ${option}`);
  }
  for (const name of VECTOR_BACKEND_SECRETS) {
    assert.match(html, new RegExp(`<input type="password" id="${name}"`), `${name} is a password input`);
  }
});
