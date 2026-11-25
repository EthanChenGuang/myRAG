import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@/lib/rag-eval/contracts.generated';

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS_DIR = path.join(ROOT, 'rag-sidecar', 'schemas');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'contracts', 'samples.json'), 'utf8')) as {
  samples: Record<string, Record<string, unknown>>;
  variants: Record<string, { model: string; value: Record<string, unknown> }>;
};

type Parser = { safeParse: (value: unknown) => { success: boolean; data?: any } };
const schemas = contracts as unknown as Record<string, Parser>;
const schemaFor = (model: string): Parser => {
  const schema = schemas[`${model}Schema`];
  if (!schema) throw new Error(`no generated schema for ${model}`);
  return schema;
};

const models = fs
  .readdirSync(SCHEMAS_DIR)
  .filter((file) => file.endsWith('.schema.json'))
  .map((file) => file.replace('.schema.json', ''))
  .sort();

describe('Python samples parse with the generated Zod schemas', () => {
  it('has one sample for every committed schema', () => {
    expect(Object.keys(fixture.samples).sort()).toEqual(models);
  });

  it.each(models)('%s sample parses and round-trips unchanged', (model) => {
    const result = schemaFor(model).safeParse(fixture.samples[model]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(fixture.samples[model]);
  });

  it.each(models)('%s rejects an unknown key', (model) => {
    const result = schemaFor(model).safeParse({ ...fixture.samples[model], unexpected_key: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key on GoldenItem and RagRunRequest', () => {
    for (const model of ['GoldenItem', 'RagRunRequest']) {
      expect(schemaFor(model).safeParse({ ...fixture.samples[model], rogue: true }).success).toBe(false);
    }
  });
});

describe('language codes come from the language-pack registry', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rag', 'language-packs.json'), 'utf8')) as {
    packs: Array<{ code: string }>;
  };
  const codes = registry.packs.map((pack) => pack.code);

  it('GoldenItem accepts every registry code and rejects an unknown one', () => {
    for (const language of codes) {
      expect(schemaFor('GoldenItem').safeParse({ ...fixture.samples.GoldenItem, language }).success, language).toBe(true);
    }
    expect(schemaFor('GoldenItem').safeParse({ ...fixture.samples.GoldenItem, language: 'xx' }).success).toBe(false);
  });

  it('the GoldenItem JSON Schema lists the registry codes in registry order', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, 'GoldenItem.schema.json'), 'utf8'));
    expect(schema.properties.language.enum).toEqual(codes);
  });
});

describe('optional and defaulted fields', () => {
  it('parses every variant', () => {
    for (const [name, variant] of Object.entries(fixture.variants)) {
      expect(schemaFor(variant.model).safeParse(variant.value).success, name).toBe(true);
    }
  });

  it('accepts a RagTrace with answer null', () => {
    const result = schemaFor('RagTrace').safeParse(fixture.variants['RagTrace:answer_null'].value);
    expect(result.success).toBe(true);
    expect(result.data.answer).toBeNull();
  });

  it('accepts a no_answer GoldenItem with expected_answer null', () => {
    const result = schemaFor('GoldenItem').safeParse(fixture.variants['GoldenItem:no_answer_null_expected'].value);
    expect(result.success).toBe(true);
    expect(result.data.expected_answer).toBeNull();
    expect(result.data.answerable).toBe(false);
  });

  it('parses RagRunRequest {query} alone and applies the defaults', () => {
    const result = schemaFor('RagRunRequest').safeParse({ query: 'What is the leave policy?' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      schema_version: 1,
      item_id: null,
      rag_mode: 'strict',
      web_search: false,
      include_answer: false,
    });
  });

  it('rejects an empty query on RagRunRequest', () => {
    expect(schemaFor('RagRunRequest').safeParse({ query: '' }).success).toBe(false);
  });
});

describe('feedback-loop contracts (Phase 5.1.1)', () => {
  const NEW_MODELS = [
    'RetrievalLogCandidate',
    'RetrievalLogEntry',
    'RefusalFeedbackRequest',
    'EmbedFeedbackRequest',
    'SourceSignalRequest',
    'ReviewItem',
    'ReviewItemListResponse',
    'ExpertLabel',
    'ExpertEvidenceSpan',
    'DictionaryTerm',
    'DictionaryCandidate',
    'TrainingPair',
    'TrainingPositive',
    'TrainingNegative',
    'FeedbackMiningConfig',
    'MiningRunResult',
    'FeedbackLoopStats',
    'WeeklyReport',
    'FailureReport',
    'FailureEntry',
    'GatePopulationConfig',
    'ShipCheckResult',
  ];

  it.each(NEW_MODELS)('%s has a committed schema, a generated parser and a sample', (model) => {
    expect(models).toContain(model);
    expect(schemas[`${model}Schema`]).toBeDefined();
    expect(fixture.samples[model]).toBeDefined();
  });

  it('a gold span without document_id parses without gaining the key', () => {
    const item = fixture.samples.GoldenItem as { gold_evidence: Array<Record<string, unknown>> };
    expect(item.gold_evidence.every((span) => !('document_id' in span))).toBe(true);
    const parsed = schemas.GoldenItemSchema?.safeParse(item);
    expect(parsed?.success).toBe(true);
    expect(parsed?.data.gold_evidence.every((span: Record<string, unknown>) => !('document_id' in span))).toBe(true);
  });

  it('language fields take codes only', () => {
    const entry = fixture.samples.RetrievalLogEntry;
    const schema = schemas.RetrievalLogEntrySchema;
    expect(schema?.safeParse({ ...entry, answer_language: 'zh-Hant' }).success).toBe(true);
    expect(schema?.safeParse({ ...entry, answer_language: 'English' }).success).toBe(false);
    expect(schema?.safeParse({ ...entry, chunk_languages: ['this is a sentence of forty characters!!'] }).success).toBe(false);
    expect(schema?.safeParse({ ...entry, query_language_confidence: 1.2 }).success).toBe(false);
  });

  it('review item tags follow the tag pattern', () => {
    const item = fixture.samples.ReviewItem;
    const schema = schemas.ReviewItemSchema;
    expect(schema?.safeParse({ ...item, tags: ['representative'] }).success).toBe(true);
    expect(schema?.safeParse({ ...item, tags: ['Representative'] }).success).toBe(false);
    expect(schema?.safeParse({ ...item, reasons: [] }).success).toBe(true);
  });

  it('feedback bodies reject a tenant or free-text field', () => {
    expect(schemas.RefusalFeedbackRequestSchema?.safeParse({ vote: 'expected_answer', tenant_key: 's:default' }).success).toBe(false);
    expect(schemas.EmbedFeedbackRequestSchema?.safeParse({ token: 't', vote: 'helpful', comment: 'x' }).success).toBe(false);
    expect(schemas.SourceSignalRequestSchema?.safeParse({ kind: 'source_opened' }).success).toBe(true);
  });

  it('gate_population accepts real on reports and baselines', () => {
    expect(schemas.EvalReportSchema?.safeParse({ ...fixture.samples.EvalReport, gate_population: 'real' }).success).toBe(true);
    expect(schemas.BaselineSchema?.safeParse({ ...fixture.samples.Baseline, gate_population: 'real' }).success).toBe(true);
  });
});
