import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@/lib/rag-eval/contracts.generated';

const ROOT = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'contracts', 'samples.json'), 'utf8')) as {
  samples: Record<string, any>;
  variants: Record<string, { model: string; value: any }>;
};

type Parser = { safeParse: (value: unknown) => { success: boolean; data?: any } };
const schemas = contracts as unknown as Record<string, Parser | undefined>;

function schemaFor(model: string): Parser {
  const schema = schemas[`${model}Schema`];
  expect(schema, `generated schema for ${model}`).toBeDefined();
  return schema as Parser;
}

const NEW_MODELS = [
  'SectionRuleSet',
  'BoilerplateRule',
  'AttributeDefinition',
  'AttributeSchema',
  'AttributeHeaderTemplate',
  'TenantRulesFile',
  'AttributeImportRow',
  'BoilerplateRulesConfig',
  'AttributeFilterConfig',
  'BoilerplateReport',
];

describe('Phase 3.3 generated contracts', () => {
  it.each(NEW_MODELS)('%s parses its default and fully populated sample', (model) => {
    const schema = schemaFor(model);
    expect(fixture.samples[model], `default sample of ${model}`).toBeDefined();
    expect(schema.safeParse(fixture.samples[model]).success).toBe(true);
    const full = fixture.variants[`${model}:full`];
    expect(full, `full sample of ${model}`).toBeDefined();
    expect(schema.safeParse(full.value).success).toBe(true);
  });

  it('rejects out-of-bound rule and attribute data', () => {
    const ruleSet = fixture.variants['SectionRuleSet:full'].value;
    expect(schemaFor('SectionRuleSet').safeParse({ ...ruleSet, headings: [] }).success).toBe(false);
    expect(schemaFor('SectionRuleSet').safeParse({ ...ruleSet, unexpected: 1 }).success).toBe(false);
    const row = fixture.samples.AttributeImportRow;
    expect(schemaFor('AttributeImportRow').safeParse({ ...row, attributes: { alpha_code: 'x'.repeat(201) } }).success).toBe(false);
    expect(schemaFor('AttributeImportRow').safeParse({ ...row, attributes: { alpha_code: 12 } }).success).toBe(false);
    expect(schemaFor('AttributeFilterConfig').safeParse({ ...fixture.samples.AttributeFilterConfig, id_cap: 0 }).success).toBe(false);
  });

  it('IngestFingerprintParts parses the sample of today and adds no chunk_prep key', () => {
    const parsed = schemaFor('IngestFingerprintParts').safeParse(fixture.samples.IngestFingerprintParts);
    expect(parsed.success).toBe(true);
    expect('chunk_prep' in parsed.data).toBe(false);
  });

  it('ProcessingProfileSet parses the repository profile file to an equal object', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rag', 'processing-profiles.json'), 'utf8'));
    const parsed = schemaFor('ProcessingProfileSet').safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(raw);
  });

  it('LanguageRegistry parses the repository registry to an equal object', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rag', 'language-packs.json'), 'utf8'));
    const parsed = schemaFor('LanguageRegistry').safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(raw);
  });

  it('RetrievalFilters accepts an attribute filter and omits it while unset', () => {
    const schema = schemaFor('RetrievalFilters');
    const parsed = schema.safeParse({ attributes: { alpha_code: ['x1'] } });
    expect(parsed.success).toBe(true);
    expect(parsed.data.attributes).toEqual({ alpha_code: ['x1'] });
    const plain = schema.safeParse({});
    expect(plain.success).toBe(true);
    expect('attributes' in plain.data).toBe(false);
    expect(schema.safeParse({ attributes: { alpha_code: [] } }).success).toBe(false);
  });

  it('GoldenItem accepts category templated_collection', () => {
    const item = { ...fixture.samples.GoldenItem, id: 'en-tpl-001', category: 'templated_collection' };
    expect(schemaFor('GoldenItem').safeParse(item).success).toBe(true);
  });

  it('RagTrace accepts the attribute filter block and a kept chunk variant index', () => {
    const variant = fixture.variants['RagTrace:phase33'];
    expect(variant).toBeDefined();
    const parsed = schemaFor('RagTrace').safeParse(variant.value);
    expect(parsed.success).toBe(true);
    expect(parsed.data.attribute_filter.mode).toBe('hard');
    expect(parsed.data.kept[0].variant_index).toBe(1);
  });

  it('EvalReport accepts the Phase 3.3 slice and item fields', () => {
    const variant = fixture.variants['EvalReport:phase33'];
    expect(variant).toBeDefined();
    const parsed = schemaFor('EvalReport').safeParse(variant.value);
    expect(parsed.success).toBe(true);
    expect(parsed.data.overall.named_document_recall.value).toBe(1);
    expect(parsed.data.items[0].named_document_hit).toBe(true);
  });
});
