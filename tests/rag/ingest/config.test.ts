import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { loadIngestConfig, resetIngestConfigForTests, type IngestConfig } from '@/lib/rag/ingest/config';

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetIngestConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
});

function ingestWarnings(): string[] {
  return warn.mock.calls
    .filter((call) => String(call[0]).includes('[Ingest Config]'))
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

const DEFAULTS: IngestConfig = {
  pipeline: 'legacy',
  parser: 'llamaparse',
  parsePollBudgetMs: 45000,
  docTypeLlmDetect: false,
  invoiceLlmExtract: false,
  exactIdLookup: false,
  pdfImageChunks: false,
  injectionScan: 'off',
  embeddingProfiles: 'off',
  qwenFallback: 'openrouter',
  domainEmbeddings: 'off',
  warnings: [],
};

describe('defaults', () => {
  test('an empty snapshot gives today\'s behaviour and logs nothing', () => {
    expect(loadIngestConfig({})).toEqual(DEFAULTS);
    expect(ingestWarnings()).toEqual([]);
  });

  test('the shipped env defaults parse to the same config without warnings', () => {
    const config = loadIngestConfig({
      RAG_INGEST_PIPELINE: 'legacy',
      RAG_PARSER: 'llamaparse',
      RAG_PARSE_POLL_BUDGET_MS: '45000',
      RAG_DOC_TYPE_LLM_DETECT: 'false',
      RAG_INVOICE_LLM_EXTRACT: 'false',
      RAG_EXACT_ID_LOOKUP: 'false',
      RAG_PDF_IMAGE_CHUNKS: 'false',
      RAG_INJECTION_SCAN: 'off',
      RAG_EMBEDDING_PROFILES: 'off',
      RAG_QWEN_EMBED_FALLBACK: 'openrouter',
    });
    expect(config).toEqual(DEFAULTS);
    expect(ingestWarnings()).toEqual([]);
  });

  test('never reads process.env', () => {
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_PARSER', 'docling');
    vi.stubEnv('RAG_INJECTION_SCAN', 'quarantine');
    vi.stubEnv('RAG_EMBEDDING_PROFILES', 'on');
    expect(loadIngestConfig({})).toEqual(DEFAULTS);
  });
});

describe('enumerated switches', () => {
  test('unified, docling, quarantine and on are accepted', () => {
    const config = loadIngestConfig({
      RAG_INGEST_PIPELINE: 'unified',
      RAG_PARSER: 'docling',
      RAG_INJECTION_SCAN: 'quarantine',
      RAG_EMBEDDING_PROFILES: 'on',
    });
    expect(config.pipeline).toBe('unified');
    expect(config.parser).toBe('docling');
    expect(config.injectionScan).toBe('quarantine');
    expect(config.embeddingProfiles).toBe('on');
    expect(ingestWarnings()).toEqual([]);
  });

  test('surrounding spaces and capitals are accepted after trim', () => {
    const config = loadIngestConfig({ RAG_INGEST_PIPELINE: 'Unified ', RAG_PARSER: '  DOCLING' });
    expect(config.pipeline).toBe('unified');
    expect(config.parser).toBe('docling');
    expect(ingestWarnings()).toEqual([]);
  });

  test('unknown values fall back to legacy, llamaparse, off and off', () => {
    const config = loadIngestConfig({
      RAG_INGEST_PIPELINE: 'foo',
      RAG_PARSER: 'bar',
      RAG_INJECTION_SCAN: 'baz',
      RAG_EMBEDDING_PROFILES: 'qux',
    });
    expect(config.pipeline).toBe('legacy');
    expect(config.parser).toBe('llamaparse');
    expect(config.injectionScan).toBe('off');
    expect(config.embeddingProfiles).toBe('off');
    expect(config.warnings).toHaveLength(4);
  });

  test('an invalid value logs one [Ingest Config] warning per distinct value', () => {
    loadIngestConfig({ RAG_INGEST_PIPELINE: 'foo' });
    loadIngestConfig({ RAG_INGEST_PIPELINE: 'foo', RAG_PARSER: 'docling' });
    loadIngestConfig({ RAG_INGEST_PIPELINE: 'foo' });
    expect(ingestWarnings()).toHaveLength(1);
    loadIngestConfig({ RAG_INGEST_PIPELINE: 'other' });
    expect(ingestWarnings()).toHaveLength(2);
  });

  test('the reset helper makes a repeated invalid value log again', () => {
    loadIngestConfig({ RAG_PARSER: 'foo' });
    resetIngestConfigForTests();
    loadIngestConfig({ RAG_PARSER: 'foo' });
    expect(ingestWarnings()).toHaveLength(2);
  });

  test('the same snapshot returns the same config object', () => {
    const first = loadIngestConfig({ RAG_PARSER: 'docling' });
    expect(loadIngestConfig({ RAG_PARSER: 'docling' })).toBe(first);
  });
});

describe('poll budget', () => {
  test.each(['1000', '45000', '55000', ' 30000 '])('%s is accepted', (value) => {
    const config = loadIngestConfig({ RAG_PARSE_POLL_BUDGET_MS: value });
    expect(config.parsePollBudgetMs).toBe(Number(value.trim()));
    expect(ingestWarnings()).toEqual([]);
  });

  test.each(['abc', '70000', '999', '55001', '-5', '1.5', '1e4'])('%s falls back to 45000 with one warning', (value) => {
    const config = loadIngestConfig({ RAG_PARSE_POLL_BUDGET_MS: value });
    expect(config.parsePollBudgetMs).toBe(45000);
    expect(ingestWarnings()).toHaveLength(1);
  });
});

describe('boolean switches', () => {
  test('true and false are accepted', () => {
    const config = loadIngestConfig({
      RAG_DOC_TYPE_LLM_DETECT: 'true',
      RAG_INVOICE_LLM_EXTRACT: 'true',
      RAG_EXACT_ID_LOOKUP: 'true',
      RAG_PDF_IMAGE_CHUNKS: 'true',
    });
    expect(config.docTypeLlmDetect).toBe(true);
    expect(config.invoiceLlmExtract).toBe(true);
    expect(config.exactIdLookup).toBe(true);
    expect(config.pdfImageChunks).toBe(true);
    expect(ingestWarnings()).toEqual([]);
  });

  test.each(['1', 'yes', 'on', 'enabled'])('%s is not true: the switch stays false with a warning', (value) => {
    const config = loadIngestConfig({ RAG_EXACT_ID_LOOKUP: value });
    expect(config.exactIdLookup).toBe(false);
    expect(ingestWarnings()).toHaveLength(1);
  });
});

describe('Qwen embedding fallback', () => {
  test('openrouter and none are accepted', () => {
    expect(loadIngestConfig({ RAG_QWEN_EMBED_FALLBACK: 'none' }).qwenFallback).toBe('none');
    expect(loadIngestConfig({ RAG_QWEN_EMBED_FALLBACK: 'openrouter' }).qwenFallback).toBe('openrouter');
    expect(ingestWarnings()).toEqual([]);
  });

  test('anything else falls back to openrouter with a warning', () => {
    expect(loadIngestConfig({ RAG_QWEN_EMBED_FALLBACK: 'deepinfra' }).qwenFallback).toBe('openrouter');
    expect(ingestWarnings()).toHaveLength(1);
  });
});
