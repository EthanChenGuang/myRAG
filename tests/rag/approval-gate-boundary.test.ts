import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { LEGACY_WRITERS } from '../../scripts/ci/check-rag-boundary.mjs';
import { INGEST_SOURCES } from '@/lib/rag/ingest/types';

// Plan 03.2-15 (D-56, D-57, SEC-09): every ingestion entry point passes the upload-approval gate. Unified callers reach it through
// ingest() / enqueueIngest() (identify decides, publish holds) and must hand it the verified uploader; every caller of a legacy
// writer must refuse while approval is on; WhatsApp has no ingestion path and may not grow one around the gate.

const ROOT = path.resolve(__dirname, '..', '..');
const MATRIX_FILE = 'tests/rag-e2e/upload-approval-paths.test.mts';
const PIPELINE_ENTRIES = new Set(['ingest', 'submitIngest', 'enqueueIngest']);
const PIPELINE_MODULES = new Set(['@/lib/rag', '@/lib/rag/ingest', '@/lib/rag/ingest/enqueue']);
const LEGACY_FUNCTIONS: Record<string, Set<string>> = {
  storeDocument: new Set(['@/lib/supabase', './supabase']),
  processDocument: new Set(['@/lib/document-processor']),
  processImageDocument: new Set(['@/lib/document-processor']),
};
const REFUSAL_RE = /\b(?:legacyWriteRefused|legacyApprovalRefusal|assertLegacyWriteAllowed|approvalRequiresUnified)\b/;
const WHATSAPP_DIRS = ['src/lib/whatsapp/', 'src/app/api/whatsapp/'];
const KB_TABLE_WRITE_RE = /\.from\s*\(\s*['"`](?:documents|document_chunks)['"`]\s*\)\s*\.\s*(?:insert|upsert|update)\s*\(/;
const WRITER_HOST = 'src/lib/supabase.ts';

type Files = Map<string, string>;

function importedNames(source: string): Array<{ name: string; from: string }> {
  const found: Array<{ name: string; from: string }> = [];
  const add = (list: string, from: string) => {
    for (const raw of list.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]?.trim();
      if (name) found.push({ name, from });
    }
  };
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) add(match[1] ?? '', match[2] ?? '');
  for (const match of source.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) add(match[1] ?? '', match[2] ?? '');
  return found;
}

const usesPipeline = (source: string) => importedNames(source).some(({ name, from }) => PIPELINE_ENTRIES.has(name) && PIPELINE_MODULES.has(from));
const usesLegacyWriter = (source: string) => importedNames(source).some(({ name, from }) => LEGACY_FUNCTIONS[name]?.has(from) === true);

/** Every way a file could write a knowledge-base document without the gate, as readable problems. */
function gateProblems(files: Files, legacyWriterPaths: readonly string[], matrix: string, sources: readonly string[]): string[] {
  const problems: string[] = [];
  const legacyCallers = new Set(legacyWriterPaths.filter((file) => file !== WRITER_HOST));
  for (const [file, source] of files) {
    if (usesLegacyWriter(source)) legacyCallers.add(file);
    if (usesPipeline(source) && !file.startsWith('src/lib/rag/') && !/\buploaderId\b/.test(source)) {
      problems.push(`${file}: calls the ingest pipeline without passing the verified uploaderId to the approval gate`);
    }
    if (WHATSAPP_DIRS.some((dir) => file.startsWith(dir))) {
      if (usesPipeline(source) || usesLegacyWriter(source) || /document-processor/.test(source) || KB_TABLE_WRITE_RE.test(source)) {
        problems.push(`${file}: WhatsApp writes knowledge-base documents; add it as an ingestion source behind the approval gate first`);
      }
    }
  }
  for (const file of legacyCallers) {
    const source = files.get(file);
    if (source === undefined) problems.push(`${file}: listed as a legacy writer but not found`);
    else if (!REFUSAL_RE.test(source)) problems.push(`${file}: runs a legacy writer without the upload-approval refusal (D-56)`);
  }
  const rows = new Set([...matrix.matchAll(/\{\s*source:\s*'([a-z_]+)'/g)].map((match) => match[1]));
  for (const source of sources) if (!rows.has(source)) problems.push(`${MATRIX_FILE}: no path-matrix row for source ${source}`);
  return problems;
}

function sourceFiles(): Files {
  const files: Files = new Map();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    }
  };
  walk('src');
  return files;
}

const legacyWriterPaths = (LEGACY_WRITERS as Array<{ path: string }>).map((writer) => writer.path);
const matrixText = fs.readFileSync(path.join(ROOT, MATRIX_FILE), 'utf8');

describe('upload-approval gate boundary (D-56, D-57)', () => {
  test('every ingestion entry point in src/ passes the gate, and every source has a path-matrix row', () => {
    expect(gateProblems(sourceFiles(), legacyWriterPaths, matrixText, INGEST_SOURCES)).toEqual([]);
  });

  test('the entry points it finds are the ones the path matrix exercises', () => {
    const files = sourceFiles();
    const pipelineCallers = [...files].filter(([file, source]) => !file.startsWith('src/lib/rag/') && usesPipeline(source)).map(([file]) => file).sort();
    expect(pipelineCallers).toEqual([
      'src/app/api/ai-to-rag/route.ts',
      'src/app/api/process-document/route.ts',
      'src/app/api/upload/route.ts',
      'src/lib/nango/document-adapter.ts',
      'src/lib/scrapers/scraper-adapter.ts',
    ]);
    const legacyCallers = [...files].filter(([, source]) => usesLegacyWriter(source)).map(([file]) => file).sort();
    expect(legacyCallers).toEqual([
      'src/app/api/upload/route.ts',
      'src/lib/document-processor.ts',
      'src/lib/nango/document-adapter.ts',
      'src/lib/scrapers/scraper-adapter.ts',
    ]);
  });

  test('the decision runs for both entry functions and the hold is enforced at publish', () => {
    const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(read('src/lib/rag/ingest/stages/identify.ts')).toMatch(/\bresolveUploadApproval\b/);
    expect(read('src/lib/rag/ingest/enqueue.ts')).toMatch(/\brunEnqueueStages\b/);
    expect(read('src/lib/rag/ingest/stages/publish.ts')).toMatch(/pending_review/);
  });

  test('trunk has no WhatsApp ingestion path', () => {
    const whatsapp = [...sourceFiles()].filter(([file]) => WHATSAPP_DIRS.some((dir) => file.startsWith(dir)));
    expect(whatsapp.length).toBeGreaterThan(0);
    expect(whatsapp.filter(([, source]) => usesPipeline(source) || usesLegacyWriter(source)).map(([file]) => file)).toEqual([]);
  });

  describe('the check catches a path added around the gate', () => {
    const base = (): Files =>
      new Map([
        ['src/lib/document-processor.ts', "import { storeDocument } from './supabase';\nassertLegacyWriteAllowed();\n"],
        ['src/app/api/upload/route.ts', "import { ingest } from '@/lib/rag';\ningest({ uploaderId });\nlegacyWriteRefused();\n"],
      ]);
    const matrix = "{ source: 'chat_upload' }, { source: 'nango' }";
    const problems = (files: Files, sources: readonly string[] = ['chat_upload', 'nango']) => gateProblems(files, [], matrix, sources);

    test('the synthetic baseline is clean', () => {
      expect(problems(base())).toEqual([]);
    });

    test('a WhatsApp file that ingests or calls a legacy writer', () => {
      const files = base();
      files.set('src/lib/whatsapp/media-ingest.ts', "import { submitIngest } from '@/lib/rag';\nsubmitIngest({ uploaderId });\n");
      files.set('src/app/api/whatsapp/save/route.ts', "const { processDocument } = await import('@/lib/document-processor');\nassertLegacyWriteAllowed();\n");
      files.set('src/lib/whatsapp/direct.ts', "admin.from('documents').insert({ status: 'ready' });\n");
      expect(problems(files)).toEqual([
        expect.stringContaining('src/lib/whatsapp/media-ingest.ts: WhatsApp'),
        expect.stringContaining('src/app/api/whatsapp/save/route.ts: WhatsApp'),
        expect.stringContaining('src/lib/whatsapp/direct.ts: WhatsApp'),
      ]);
    });

    test('a legacy-writer caller without the refusal', () => {
      const files = base();
      files.set('src/lib/importer.ts', "import { processDocument } from '@/lib/document-processor';\nprocessDocument(name, bytes, {});\n");
      expect(problems(files)).toEqual([expect.stringContaining('src/lib/importer.ts: runs a legacy writer without the upload-approval refusal')]);
    });

    test('a listed legacy writer without the refusal', () => {
      const files = base();
      files.set('src/app/api/legacy-save/route.ts', "admin.from('documents').insert(row);\n");
      expect(gateProblems(files, ['src/app/api/legacy-save/route.ts'], matrix, ['chat_upload'])).toEqual([
        expect.stringContaining('src/app/api/legacy-save/route.ts: runs a legacy writer'),
      ]);
    });

    test('a pipeline caller that does not pass the uploader', () => {
      const files = base();
      files.set('src/lib/feeds/rss.ts', "import { ingest } from '@/lib/rag';\ningest({ scope, source: 'chat_upload' });\n");
      expect(problems(files)).toEqual([expect.stringContaining('src/lib/feeds/rss.ts: calls the ingest pipeline without passing the verified uploaderId')]);
    });

    test('a new ingestion source without a path-matrix row', () => {
      expect(problems(base(), ['chat_upload', 'nango', 'whatsapp'])).toEqual([expect.stringContaining('no path-matrix row for source whatsapp')]);
    });
  });
});
