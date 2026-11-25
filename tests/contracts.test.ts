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

describe('Phase 3.2 scope filter and translation leg weight (plan 03.2-06)', () => {
  const filters = () => schemaFor('RetrievalFilters');

  it('the generated filter schema accepts a scopes filter with includeUntagged', () => {
    const result = filters().safeParse({
      ...fixture.samples.RetrievalFilters,
      scopes: { region: ['north'], legal_entity: ['unit-a'], department: ['unit-b'] },
      include_untagged: true,
    });
    expect(result.success).toBe(true);
    expect(result.data.scopes).toEqual({ region: ['north'], legal_entity: ['unit-a'], department: ['unit-b'] });
    expect(result.data.include_untagged).toBe(true);
  });

  it('the generated filter schema rejects a fourth dimension and a non-slug value', () => {
    expect(filters().safeParse({ scopes: { region: ['north'], project: ['north'] } }).success).toBe(false);
    expect(filters().safeParse({ scopes: { region: ['North'] } }).success).toBe(false);
  });

  it('a filter without scopes parses without adding scope keys', () => {
    const result = filters().safeParse(fixture.samples.RetrievalFilters);
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('scopes');
    expect(result.data).not.toHaveProperty('include_untagged');
  });

  it('leg weights accept an optional translation weight and omit it by default', () => {
    const params = schemaFor('RetrievalParams');
    const withTranslation = params.safeParse({
      ...fixture.samples.RetrievalParams,
      leg_weights: { dense: 1, lexical: 1, exact_id: 1, translation: 0.5 },
    });
    expect(withTranslation.success).toBe(true);
    expect(withTranslation.data.leg_weights.translation).toBe(0.5);
    const plain = params.safeParse(fixture.samples.RetrievalParams);
    expect(plain.data.leg_weights).not.toHaveProperty('translation');
    expect(fixture.variants['RetrievalFilters:scopes']?.model).toBe('RetrievalFilters');
  });
});
