import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { END_MARKER, START_MARKER, extractGenerated, renderSwitchTables } from '../../scripts/rag/gen-pipeline-doc.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/rag/gen-pipeline-doc.mjs');
const MANIFEST_PATH = path.join(ROOT, 'scripts/rag/env-manifest.json');
const DOC_PATH = path.join(ROOT, 'README_RAG_PIPELINE.md');

interface ManifestEntry {
  name: string;
  status: string;
  label?: string;
  default?: string;
  type?: string;
  group?: string;
}
interface Manifest {
  vars: ManifestEntry[];
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
const readDoc = () => (fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '');

function runCheck(manifestPath: string, docPath: string) {
  return spawnSync(process.execPath, [SCRIPT, '--check', '--manifest', manifestPath, '--doc', docPath], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-doc-'));
}

describe('README_RAG_PIPELINE.md generated tables', () => {
  test('drift: the generated region equals renderSwitchTables of the committed manifest', () => {
    const doc = readDoc();
    expect(doc).toContain(START_MARKER);
    expect(doc).toContain(END_MARKER);
    expect(extractGenerated(doc)).toBe(renderSwitchTables(manifest));
  });

  test('drift: a changed label in a fixture manifest makes the comparison fail', () => {
    const changed = structuredClone(manifest);
    const target = changed.vars.find((entry) => entry.status === 'managed');
    expect(target).toBeDefined();
    target!.label = `${target!.label} changed`;
    expect(renderSwitchTables(changed)).not.toBe(extractGenerated(readDoc()));
  });

  test('drift: a hand-edited row in the generated region fails --check', () => {
    const dir = tempDir();
    const doc = readDoc();
    const edited = doc.replace(/\| `RAG_PIPELINE` \| [^|]+\|/, '| `RAG_PIPELINE` | Hand-edited label |');
    expect(edited).not.toBe(doc);
    fs.writeFileSync(path.join(dir, 'doc.md'), edited);
    expect(runCheck(MANIFEST_PATH, path.join(dir, 'doc.md')).status).toBe(1);
    expect(runCheck(MANIFEST_PATH, DOC_PATH).status).toBe(0);
  });

  test('rendering is deterministic, one table per group, every managed variable listed once', () => {
    const rendered = renderSwitchTables(manifest) as string;
    expect(renderSwitchTables(structuredClone(manifest))).toBe(rendered);
    const managed = manifest.vars.filter((entry) => entry.status === 'managed');
    for (const entry of managed) {
      const rows = rendered.split('\n').filter((line) => line.startsWith(`| \`${entry.name}\` |`));
      expect(rows, entry.name).toHaveLength(1);
      if (entry.type === 'secret') expect(rows[0], entry.name).toContain('| (secret) |');
    }
    const groups = new Set(managed.map((entry) => entry.group));
    expect(rendered.match(/^### .+ \(`[a-z]+`\)$/gm)).toHaveLength(groups.size);
    for (const entry of manifest.vars.filter((item) => item.status === 'legacy')) {
      expect(rendered, entry.name).not.toContain(`| \`${entry.name}\` |`);
    }
  });

  test('without --check the generator rewrites only the marked region', () => {
    const dir = tempDir();
    const docPath = path.join(dir, 'doc.md');
    fs.writeFileSync(docPath, `# Title\n\nBefore.\n\n${START_MARKER}\nstale\n${END_MARKER}\n\nAfter.\n`);
    const result = spawnSync(process.execPath, [SCRIPT, '--manifest', MANIFEST_PATH, '--doc', docPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const written = fs.readFileSync(docPath, 'utf8');
    expect(written.startsWith('# Title\n\nBefore.\n\n')).toBe(true);
    expect(written.endsWith(`${END_MARKER}\n\nAfter.\n`)).toBe(true);
    expect(extractGenerated(written)).toBe(renderSwitchTables(manifest));
  });
});

describe('README_RAG_PIPELINE.md content', () => {
  test.each(['Sidecar', 'Providers and switches', 'Vector sync', 'Backends', 'Evaluation workflow', 'Data flow'])(
    'has the %s section',
    (title) => {
      expect(readDoc()).toMatch(new RegExp(`^## ${title}$`, 'm'));
    },
  );

  test.each([
    'docs/vendor-data-flow.md',
    'supabase/optional/vector-sync-schedule.sql',
    'CRON_SECRET',
    'RAG_VECTOR_SYNC_MAX_LAG_SECONDS',
    'after()',
    'npm run rag:vector-sync -- targets enable',
    'npm run rag:reconcile',
    'requeue-dead',
    'RAG_RETRIEVAL_BACKEND_VOICE',
    'eval/decisions/test-split-ledger.jsonl',
    'rag_eval.regression',
    'rag_eval.failure_report',
    'review_queue promote-db',
    '`lexical_text` and vectors',
  ])('mentions %s', (fragment) => {
    expect(readDoc()).toContain(fragment);
  });

  test('no line carries a key-like string', () => {
    const offending = readDoc()
      .split('\n')
      .filter((line) => /sk-[A-Za-z0-9]|eyJ[A-Za-z0-9]/.test(line) || /(?<![A-Za-z0-9<_-])[A-Fa-f0-9]{32,}(?![A-Za-z0-9>])/.test(line) || /(?<![A-Za-z0-9<_/.-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9>])/.test(line));
    expect(offending).toEqual([]);
  });

  test('every URL host is a placeholder, a local host, a manifest default or a documentation host', () => {
    const defaults = new Set(
      manifest.vars
        .map((entry) => entry.default ?? '')
        .filter((value) => /^https?:\/\//.test(value))
        .map((value) => new URL(value).hostname),
    );
    const docs = new Set(['vercel.com', 'supabase.com', 'docs.weaviate.io', 'qdrant.tech', 'github.com']);
    const hosts = [...readDoc().matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((match) => match[1]);
    const bad = hosts.filter(
      (host) => !(host === 'localhost' || host === '127.0.0.1' || host === 'example.com' || host.endsWith('.example.com') || defaults.has(host) || docs.has(host)),
    );
    expect(bad).toEqual([]);
  });
});

describe('README_RAG_PIPELINE.md revision-4 workflows', () => {
  test.each([
    '## Per-language monitoring',
    '## Rollouts',
    '## Language addition and removal',
    '## Red-team run',
    '### Purges',
    '### Lexical parameters on external backends',
    '### Source-of-truth recheck',
    '### Access groups on external backends',
    '### Decision-record numbers',
  ])('has the heading %s', (heading) => {
    expect(readDoc()).toMatch(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  });

  test.each([
    'npm run rag:rollout',
    'npm run rag:languages',
    'npm run rag:red-team',
    'rebuild-lexical',
    'rag_vector_sync_purge_status',
    'rag_vector_sync_purge_reopen',
    'stale_index_drop',
    'rag_validate_chunks_for_groups',
    '`access_groups`',
    'RAG_DOC_ACCESS_GROUPS',
    '/api/rag/admin/language-quality',
    'language_drop',
    'RAG_LANG_CONFIDENCE',
    'calibrate-language-confidence.mts',
    'RAG_ROLLOUTS',
    'config/rag/rollout-policy.json',
    'config/rag/price-table.json',
    'RAG_LEXICAL_BM25_K1',
    'RAG_LEXICAL_BM25_B',
  ])('mentions %s', (fragment) => {
    expect(readDoc()).toContain(fragment);
  });

  test('the revision-4 sections sit outside the generated region', () => {
    const doc = readDoc();
    const generated = doc.slice(doc.indexOf(START_MARKER), doc.indexOf(END_MARKER));
    for (const fragment of ['npm run rag:rollout', 'npm run rag:red-team', 'rebuild-lexical', 'stale_index_drop']) {
      expect(generated, fragment).not.toContain(fragment);
    }
  });

  test('the contents list names every top-level section', () => {
    const doc = readDoc();
    const contents = doc.slice(doc.indexOf('## Contents'), doc.indexOf('## Sidecar'));
    for (const title of ['Per-language monitoring', 'Rollouts', 'Language addition and removal', 'Red-team run']) {
      expect(contents, title).toContain(`[${title}]`);
    }
  });
});
