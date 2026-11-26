import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { RunEvalResult } from '../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TRACER_ITEM_ID = 'en-general-001';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000f2';
const LANGUAGES = ['zh', 'en', 'it'] as const;
const TIMEOUT_MS = 120_000;

interface GoldenLine {
  id: string;
  language: string;
  category: string;
  answerable: boolean;
  gold_evidence: { document: string }[];
}

interface Trace {
  item_id: string | null;
  candidates: unknown[];
  kept: { document_name?: string | null }[];
  refused: boolean;
}

interface DumpChunk {
  index: number;
  section: string;
  text: string;
  stored: string;
}

interface DumpDocument {
  relpath: string;
  filename: string;
  language: string;
  doc_type: string;
  chunks: DumpChunk[];
  version?: number;
  version_label?: string;
  effective_from?: string;
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-corpus-test-'));
  tmpDirs.push(dir);
  return dir;
}

function readLines<T>(file: string): T[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixture corpus loaders', () => {
  test('the TS loader and rag_eval.corpus produce identical documents, chunks, sections and stored contents', async () => {
    const { loadCorpus } = await import('../eval/harness/corpus.mts');
    const loaded = loadCorpus(CORPUS_DIR);
    const dump = spawnSync('uv', ['run', '--directory', 'eval', 'python', '-m', 'rag_eval.corpus', 'dump', CORPUS_DIR], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(dump.status, dump.stderr).toBe(0);
    const python = JSON.parse(dump.stdout) as DumpDocument[];

    expect(loaded.documents).toHaveLength(34);
    const fromTs = loaded.documents.map((doc) => ({
      relpath: doc.relpath,
      filename: doc.filename,
      language: doc.language,
      doc_type: doc.docType,
      chunks: doc.chunks.map((chunk) => ({ index: chunk.index, section: chunk.section, text: chunk.text, stored: chunk.stored })),
      ...(doc.version !== undefined ? { version: doc.version } : {}),
      ...(doc.versionLabel !== undefined ? { version_label: doc.versionLabel } : {}),
      ...(doc.effectiveFrom !== undefined ? { effective_from: doc.effectiveFrom } : {}),
    }));
    expect(fromTs).toEqual(python);
    for (const doc of loaded.documents) {
      expect(doc.content).toBe(doc.chunks.map((chunk) => chunk.text).join('\n\n'));
    }
  }, TIMEOUT_MS);
});

describe('full fixture set through the in-process harness', () => {
  let single: RunEvalResult;
  let traces: Trace[] = [];
  const golden = readLines<GoldenLine>(GOLDEN_PATH);

  test('every golden item produces one trace with zero edge errors', async () => {
    vi.resetModules();
    const { runEval } = await import('../eval/harness/run-eval.mts');
    single = await runEval({ goldenPath: GOLDEN_PATH, corpusDir: CORPUS_DIR, outDir: makeTmpDir(), deploymentMode: 'single-tenant' });
    traces = readLines<Trace>(single.tracesPath);
    expect(golden.length).toBeGreaterThanOrEqual(90);
    expect(single.edgeErrors).toBe(0);
    expect(single.manifest.edge_errors).toBe(0);
    expect(traces).toHaveLength(golden.length);
    expect(traces.map((trace) => trace.item_id)).toEqual(golden.map((item) => item.id));
  }, TIMEOUT_MS);

  test.each(LANGUAGES)('%s: some answerable item keeps its gold document in the top 10 and some out-of-domain item is refused', (language) => {
    expect(traces).toHaveLength(golden.length);
    const byId = new Map(traces.map((trace) => [trace.item_id, trace]));
    const inLanguage = golden.filter((item) => item.language === language);

    const hits = inLanguage.filter((item) => {
      if (!item.answerable) return false;
      const documents = new Set(item.gold_evidence.map((span) => span.document));
      const kept = byId.get(item.id)?.kept.slice(0, 10) ?? [];
      return kept.some((chunk) => chunk.document_name && documents.has(chunk.document_name));
    });
    expect(hits.length, `${language} answerable items with a gold document in kept ranks 1-10`).toBeGreaterThan(0);

    const outOfDomain = inLanguage.filter((item) => item.category === 'no_answer' && /-no-answer-00[34]$/.test(item.id));
    expect(outOfDomain).toHaveLength(2);
    const refused = outOfDomain.filter((item) => byId.get(item.id)?.refused === true);
    expect(refused.length, `${language} refused out-of-domain items`).toBeGreaterThan(0);
  });
});

describe('multi-tenant retrieval', () => {
  test('the tracer item retrieves for the fixture user and returns zero candidates for another user id', async () => {
    const tracerLine = fs
      .readFileSync(GOLDEN_PATH, 'utf8')
      .split('\n')
      .find((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return (JSON.parse(trimmed) as { id: string }).id === TRACER_ITEM_ID;
      });
    expect(tracerLine).toBeDefined();
    const dir = makeTmpDir();
    const tracerGolden = path.join(dir, 'tracer.jsonl');
    fs.writeFileSync(tracerGolden, `${tracerLine}\n`);

    const runFresh = async (outName: string, requestOptions?: { user_id: string }) => {
      vi.resetModules();
      const { runEval } = await import('../eval/harness/run-eval.mts');
      return runEval({
        goldenPath: tracerGolden,
        corpusDir: CORPUS_DIR,
        outDir: path.join(dir, outName),
        deploymentMode: 'multi-tenant',
        ...(requestOptions ? { requestOptions } : {}),
      });
    };
    const own = await runFresh('own');
    const other = await runFresh('other', { user_id: OTHER_USER_ID });

    expect(own.edgeErrors).toBe(0);
    expect(other.edgeErrors).toBe(0);
    const [ownTrace] = readLines<Trace>(own.tracesPath);
    const [otherTrace] = readLines<Trace>(other.tracesPath);
    expect(ownTrace.candidates.length).toBeGreaterThan(0);
    expect(ownTrace.kept.map((chunk) => chunk.document_name)).toContain('refund-policy.en.md');
    expect(otherTrace.candidates).toHaveLength(0);
    expect(otherTrace.kept).toHaveLength(0);
  }, TIMEOUT_MS);
});
