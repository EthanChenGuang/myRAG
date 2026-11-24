import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@/lib/rag-eval/contracts.generated';

const ROOT = path.resolve(__dirname, '..');
const fixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'contracts', 'samples.json'), 'utf8'),
) as { samples: Record<string, Record<string, unknown>> };

type Parser = { safeParse: (value: unknown) => { success: boolean } };
const schemas = contracts as unknown as Record<string, Parser>;
const schemaFor = (model: string): Parser => {
  const schema = schemas[`${model}Schema`];
  if (!schema) throw new Error(`no generated schema for ${model}`);
  return schema;
};

const INGEST_QUEUE_MODELS = [
  'PreflightResult',
  'PageStructureVerdict',
  'ParseRoutingConfig',
  'ParseAttempt',
  'QualityCheckResult',
  'JobSettingsSnapshot',
  'IngestionJob',
  'DetectVlmRequest',
  'DetectVlmResponse',
  'ParseExternalRequest',
  'ParseExternalResponse',
  'AdvanceRequest',
  'AdvanceResponse',
  'BackfillManifestEntry',
  'BackfillDryRunReport',
  'ParserExpected',
  'ParserEvalReport',
  'ParseGateReport',
] as const;

const invalidByModel: Record<
  (typeof INGEST_QUEUE_MODELS)[number],
  (sample: Record<string, unknown>) => Record<string, unknown>
> = {
  PreflightResult: (sample) => ({ ...sample, page_count: 0 }),
  PageStructureVerdict: (sample) => ({ ...sample, confidence: 1.5 }),
  ParseRoutingConfig: (sample) => ({ ...sample, version: 1 }),
  ParseAttempt: (sample) => ({ ...sample, attempt_no: 0 }),
  QualityCheckResult: (sample) => ({ ...sample, score: 2 }),
  JobSettingsSnapshot: (sample) => ({ ...sample, ocr_languages: [] }),
  IngestionJob: (sample) => ({ ...sample, status: 'bogus' }),
  DetectVlmRequest: (sample) => ({ ...sample, pages: [] }),
  DetectVlmResponse: () => ({ worker_id: '', pages: [] }),
  ParseExternalRequest: (sample) => ({ ...sample, mode: 'bogus' }),
  ParseExternalResponse: (sample) => ({ ...sample, status: 'bogus' }),
  AdvanceRequest: (sample) => ({ ...sample, deadline_ms: 99_999 }),
  AdvanceResponse: (sample) => ({ ...sample, done: 'yes' }),
  BackfillManifestEntry: () => ({ source_key: '', path: null, url: null }),
  BackfillDryRunReport: (sample) => ({ ...sample, fits_budget: 'yes' }),
  ParserExpected: (sample) => ({
    ...sample,
    pages: [{ page: 0, signals: [], tier: 'fast', preset: 'fast' }],
  }),
  ParserEvalReport: (sample) => ({
    ...sample,
    by_tier: {
      fast: {
        text_similarity: 2,
        table_cell_f1: 0,
        reading_order: 0,
        headings_f1: 0,
        s_per_page: 0,
        cost_per_page: 0,
        recall_at_k: 0,
      },
    },
  }),
  ParseGateReport: (sample) => ({ ...sample, passed: 'yes' }),
};

describe('ingest queue contracts', () => {
  it.each(INGEST_QUEUE_MODELS)('%s sample parses with generated Zod', (model) => {
    const sample = fixture.samples[model];
    expect(sample, `missing fixture sample for ${model}`).toBeTruthy();
    expect(schemaFor(model).safeParse(sample).success).toBe(true);
  });

  it.each(INGEST_QUEUE_MODELS)('%s rejects a known invalid case', (model) => {
    const sample = fixture.samples[model];
    const invalid = invalidByModel[model](sample);
    expect(schemaFor(model).safeParse(invalid).success).toBe(false);
  });

  it('rejects an unknown key on callback bodies', () => {
    for (const model of ['DetectVlmRequest', 'ParseExternalRequest', 'AdvanceRequest'] as const) {
      const sample = fixture.samples[model];
      expect(schemaFor(model).safeParse({ ...sample, tenant_key: 'forged' }).success).toBe(false);
    }
  });
});