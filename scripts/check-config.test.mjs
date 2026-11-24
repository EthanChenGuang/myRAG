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
