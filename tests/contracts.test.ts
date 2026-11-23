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
