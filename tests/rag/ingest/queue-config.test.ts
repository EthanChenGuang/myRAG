import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { loadQueueConfig, resetQueueConfigForTests, type QueueConfig } from '@/lib/rag/ingest/queue-config';

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  resetIngestConfigForTests();
  resetQueueConfigForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function ingestWarnings(): string[] {
  return warn.mock.calls
    .filter((call) => String(call[0]).includes('[Ingest]'))
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

const DEFAULTS: QueueConfig = {
  parseRouting: 'fixed',
  parserAllowCloud: true,
  premiumPageBudget: 0,
  premiumMaxPagesPerDoc: 200,
  parseEscalation: 'on',
  vlmDetect: false,
  vlmModel: null,
  ingestAsync: false,
  workerConcurrency: 2,
  parseProgressive: false,
  embedBatchMode: 'sync',
  ingestRealtime: false,
  warnings: [],
};

describe('defaults', () => {
  test('an empty snapshot gives Phase 3 behaviour and logs nothing', () => {
    expect(loadQueueConfig({})).toEqual(DEFAULTS);
    expect(ingestWarnings()).toEqual([]);
  });
});

describe('parse routing', () => {
  test('tiered with legacy pipeline falls back to fixed with one warning', () => {
    const config = loadQueueConfig({ RAG_PARSE_ROUTING: 'tiered', RAG_INGEST_PIPELINE: 'legacy' });
    expect(config.parseRouting).toBe('fixed');
    expect(ingestWarnings().length).toBe(1);
    loadQueueConfig({ RAG_PARSE_ROUTING: 'tiered', RAG_INGEST_PIPELINE: 'legacy' });
    expect(ingestWarnings().length).toBe(1);
  });

  test('tiered with unified and async on stays tiered', () => {
    const config = loadQueueConfig({
      RAG_PARSE_ROUTING: 'tiered',
      RAG_INGEST_PIPELINE: 'unified',
      RAG_INGEST_ASYNC: 'on',
    });
    expect(config.parseRouting).toBe('tiered');
    expect(ingestWarnings()).toEqual([]);
  });
});

describe('async ingest', () => {
  test('on with legacy pipeline resolves to off with a warning', () => {
    const config = loadQueueConfig({ RAG_INGEST_ASYNC: 'on', RAG_INGEST_PIPELINE: 'legacy' });
    expect(config.ingestAsync).toBe(false);
    expect(ingestWarnings().length).toBe(1);
  });
});

describe('vlm detect', () => {
  test('true under fixed routing resolves to false', () => {
    const config = loadQueueConfig({ RAG_PARSE_VLM_DETECT: 'true' });
    expect(config.vlmDetect).toBe(false);
  });

  test('true under tiered stays true', () => {
    const config = loadQueueConfig({
      RAG_PARSE_VLM_DETECT: 'true',
      RAG_PARSE_ROUTING: 'tiered',
      RAG_INGEST_PIPELINE: 'unified',
      RAG_INGEST_ASYNC: 'on',
    });
    expect(config.vlmDetect).toBe(true);
  });
});

describe('parser allow cloud', () => {
  test.each(['true', '1', 'yes', 'on', 'TRUE', ' On ', 'Yes'])('explicit truthy value %j allows cloud', (value) => {
    expect(loadQueueConfig({ RAG_PARSER_ALLOW_CLOUD: value }).parserAllowCloud).toBe(true);
    expect(ingestWarnings().length).toBe(0);
  });

  test.each([undefined, '', '   '])('unset or empty (%j) keeps the documented default of allowed', (value) => {
    expect(loadQueueConfig({ RAG_PARSER_ALLOW_CLOUD: value }).parserAllowCloud).toBe(true);
    expect(ingestWarnings().length).toBe(0);
  });

  test.each(['false', '0', 'off', 'no', 'disabled', 'FALSE', 'Off', 'NO'])('%j refuses cloud', (value) => {
    expect(loadQueueConfig({ RAG_PARSER_ALLOW_CLOUD: value }).parserAllowCloud).toBe(false);
  });

  test.each(['maybe', 'ture', 'enabled', '2', 'allow'])('unrecognised value %j fails closed with one warning', (value) => {
    expect(loadQueueConfig({ RAG_PARSER_ALLOW_CLOUD: value }).parserAllowCloud).toBe(false);
    loadQueueConfig({ RAG_PARSER_ALLOW_CLOUD: value });
    expect(ingestWarnings().length).toBe(1);
  });
});

describe('numeric fields', () => {
  test('invalid budget values fall back to default with one warning per distinct value', () => {
    const config = loadQueueConfig({ RAG_PARSE_PREMIUM_PAGE_BUDGET: '-1' });
    expect(config.premiumPageBudget).toBe(0);
    loadQueueConfig({ RAG_PARSE_PREMIUM_PAGE_BUDGET: '-1' });
    expect(ingestWarnings().length).toBe(1);
    loadQueueConfig({ RAG_PARSE_PREMIUM_PAGE_BUDGET: 'x' });
    expect(ingestWarnings().length).toBe(2);
  });

  test('invalid concurrency falls back to 2', () => {
    expect(loadQueueConfig({ RAG_INGEST_WORKER_CONCURRENCY: '0' }).workerConcurrency).toBe(2);
  });
});

describe('vlm model', () => {
  test('empty string means null (captioning model)', () => {
    expect(loadQueueConfig({}).vlmModel).toBeNull();
    expect(loadQueueConfig({ RAG_PARSE_VLM_MODEL: '' }).vlmModel).toBeNull();
    expect(loadQueueConfig({ RAG_PARSE_VLM_MODEL: 'custom-model' }).vlmModel).toBe('custom-model');
  });
});