import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { createLlamaParseParser, resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { createSidecarParser, resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { mintScope } from '@/lib/rag/tenant/scope';
import { startFakeLlamaParse, type FakeLlamaParse } from '../helpers/fake-llamaparse';
import { startFakeSidecar, type FakeSidecar } from '../helpers/fake-sidecar';
import { fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../helpers/ingest-fakes';

/**
 * The scan_zh_it parse fixture (03.2-25, D-18). The fakes serve recordings built from the fixture spec, so this proves the request shape
 * and that the text reaches the chunk stage unchanged; real OCR quality is the sidecar's nightly real_docling check and a live check.
 */
const chunkerInputs = vi.hoisted(() => [] as Array<{ markdown: string; chunks: Array<{ text: string }> | null }>);

vi.mock('@/lib/rag/ingest/chunkers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/ingest/chunkers')>();
  return {
    ...original,
    chunkDocument: (...args: Parameters<typeof original.chunkDocument>) => {
      chunkerInputs.push({ markdown: args[1].markdown, chunks: (args[1].chunks ?? null) as Array<{ text: string }> | null });
      return original.chunkDocument(...args);
    },
  };
});

const PARSE = join(process.cwd(), 'eval/fixtures/parse');
const FIXTURE_ID = 'scan-zh-it';
const scope = mintScope('single', null, null);

interface ParseManifestRow {
  id: string;
  sha256: string;
  pdf_path: string;
}

const row = (JSON.parse(readFileSync(join(PARSE, 'manifest.json'), 'utf8')) as { fixtures: ParseManifestRow[] }).fixtures.find(
  (entry) => entry.id === FIXTURE_ID,
);
const recordedDir = (): string => join(PARSE, 'recorded', row?.sha256 ?? 'missing');
function readJson(path: string): unknown {
  expect(existsSync(path), `missing ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8'));
}
const expectedText = (): string => readFileSync(join(PARSE, 'expected', `${FIXTURE_ID}.txt`), 'utf8');
const pdfBytes = (): Uint8Array => new Uint8Array(readFileSync(join(PARSE, `${row?.pdf_path.replace(/^fixtures\/parse\//, '')}`)));

/** Text blocks one per line, with Markdown heading markers and blank lines removed: the shape of the expected file. */
function blocks(markdown: string): string {
  const lines = markdown.split('\n').map((line) => line.trim().replace(/^#+\s+/, ''));
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}

async function ingestScan(env: Record<string, string>): Promise<void> {
  const db = fakeIngestDb();
  installIngestDeps({ db: db.db, env: { RAG_INGEST_PIPELINE: 'unified', ...env } });
  const outcome = await ingest({
    scope,
    source: 'config_upload',
    sourceKey: `root/${FIXTURE_ID}.pdf`,
    file: pdfBytes(),
    filename: `${FIXTURE_ID}.pdf`,
    mimeType: 'application/pdf',
    docType: 'general',
    signal: new AbortController().signal,
  });
  expect(outcome.status).toBe('ready');
}

const saved = { supported: process.env.RAG_SUPPORTED_LANGUAGES, primary: process.env.RAG_PRIMARY_LANGUAGE };

beforeEach(() => {
  chunkerInputs.length = 0;
  process.env.RAG_SUPPORTED_LANGUAGES = 'zh,it';
  process.env.RAG_PRIMARY_LANGUAGE = 'zh';
  resetLanguageSettingsForTests();
  for (const method of ['log', 'info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallIngestDeps();
  resetSidecarParserForTests();
  resetLlamaParseParserForTests();
  if (saved.supported === undefined) delete process.env.RAG_SUPPORTED_LANGUAGES;
  else process.env.RAG_SUPPORTED_LANGUAGES = saved.supported;
  if (saved.primary === undefined) delete process.env.RAG_PRIMARY_LANGUAGE;
  else process.env.RAG_PRIMARY_LANGUAGE = saved.primary;
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

test('the scan_zh_it fixture is in the parse manifest', () => {
  expect(row?.id).toBe(FIXTURE_ID);
});

describe('Docling through the sidecar, RAG_SUPPORTED_LANGUAGES=zh,it with primary zh', () => {
  let fake: FakeSidecar;

  beforeEach(async () => {
    fake = await startFakeSidecar();
    setSidecarParserForTests(createSidecarParser({ baseUrl: fake.url, secret: fake.secret, sleep: async () => undefined }));
  });

  afterEach(async () => {
    await fake.close();
  });

  test('the request carries the registry OCR codes and equals the recorded request body', async () => {
    await ingestScan({ RAG_PARSER: 'docling' });
    expect(fake.uploads).toHaveLength(1);
    const upload = fake.uploads[0];
    expect(upload?.fileSha256).toBe(row?.sha256);
    expect(upload?.request.ocr_languages).toEqual(['zh', 'it']);
    expect(upload?.request).toEqual(readJson(join(recordedDir(), 'requests', 'docling.json')));
  });

  test('the parse text that reaches the chunk stage equals the expected text', async () => {
    await ingestScan({ RAG_PARSER: 'docling' });
    expect(chunkerInputs).toHaveLength(1);
    const input = chunkerInputs[0];
    expect(blocks(input?.markdown ?? '')).toBe(expectedText());
    const expectedLines = new Set(expectedText().split('\n'));
    for (const chunk of input?.chunks ?? []) {
      for (const line of chunk.text.split('\n')) expect(expectedLines.has(line)).toBe(true);
    }
  });
});

describe('LlamaParse v2, RAG_SUPPORTED_LANGUAGES=zh,it with primary zh', () => {
  let fake: FakeLlamaParse;

  beforeEach(async () => {
    fake = await startFakeLlamaParse();
    fake.enqueue({ pages: [{ page_number: 1, success: true, markdown: readFileSync(join(recordedDir(), 'premium', 'page-1.md'), 'utf8') }] });
    setLlamaParseParserForTests(createLlamaParseParser({ baseUrl: fake.url, apiKey: fake.apiKey, tier: 'cost_effective', sleep: async () => undefined }));
  });

  afterEach(async () => {
    await fake.close();
  });

  test('the configuration carries the LlamaParse codes, primary first, and equals the recorded configuration', async () => {
    await ingestScan({ RAG_PARSER: 'llamaparse', LLAMA_CLOUD_API_KEY: 'llx-test-key-0000' });
    expect(fake.uploads).toHaveLength(1);
    const configuration = fake.uploads[0]?.configuration as { processing_options?: { ocr_parameters?: { languages?: string[] } } };
    expect(configuration.processing_options?.ocr_parameters?.languages).toEqual(['ch_sim', 'it']);
    expect(configuration).toEqual(readJson(join(recordedDir(), 'requests', 'llamaparse.json')));
  });

  test('the parse text that reaches the chunk stage equals the expected text', async () => {
    await ingestScan({ RAG_PARSER: 'llamaparse', LLAMA_CLOUD_API_KEY: 'llx-test-key-0000' });
    expect(chunkerInputs).toHaveLength(1);
    expect(blocks(chunkerInputs[0]?.markdown ?? '')).toBe(expectedText());
  });
});
