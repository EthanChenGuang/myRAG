import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@/lib/rag-eval/contracts.generated';

const ROOT = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'contracts', 'samples.json'), 'utf8')) as {
  samples: Record<string, any>;
};

type Parser = { safeParse: (value: unknown) => { success: boolean; data?: any } };
const schemas = contracts as unknown as Record<string, Parser | undefined>;

function schemaFor(model: string): Parser {
  const schema = schemas[`${model}Schema`];
  expect(schema, `generated schema for ${model}`).toBeDefined();
  return schema as Parser;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const WIRE_MODELS = [
  'ProcessingProfileSet',
  'DocTypeDetection',
  'InjectionRuleSet',
  'ParseJobRequest',
  'ParseJobAccepted',
  'ParseJobState',
  'ParseResult',
  'InvoiceExtractRequest',
  'InvoiceFields',
];

describe('ingest contracts generated from Pydantic', () => {
  it.each(WIRE_MODELS)('%s sample parses and round-trips unchanged', (model) => {
    const result = schemaFor(model).safeParse(fixture.samples[model]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(fixture.samples[model]);
  });

  it('keeps the table chunk header rows in the ParseResult sample', () => {
    const sample = fixture.samples.ParseResult;
    const parsed = schemaFor('ParseResult').safeParse(sample);
    expect(parsed.success).toBe(true);
    expect(sample.chunks).toHaveLength(2);
    const table = parsed.data.chunks.find((chunk: { is_table: boolean }) => chunk.is_table);
    expect(table.table_header.split('\n')).toHaveLength(2);
    expect(table.text.startsWith(table.table_header)).toBe(true);
  });

  it('rejects an unknown key on ParseResult, at the top and inside a chunk or picture', () => {
    const schema = schemaFor('ParseResult');
    const base = fixture.samples.ParseResult;
    expect(schema.safeParse({ ...base, unexpected_key: 1 }).success).toBe(false);
    const chunky = clone(base);
    chunky.chunks[0].unexpected_key = 1;
    expect(schema.safeParse(chunky).success).toBe(false);
    const pictured = clone(base);
    pictured.pictures[0].unexpected_key = 1;
    expect(schema.safeParse(pictured).success).toBe(false);
  });

  it('rejects ParseResult values the sidecar must never send', () => {
    const schema = schemaFor('ParseResult');
    const base = fixture.samples.ParseResult;
    expect(schema.safeParse({ ...base, parser: 'tesseract' }).success).toBe(false);
    expect(schema.safeParse({ ...base, artifacts: ['../secret'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, text_layer_page_share: 1.5 }).success).toBe(false);
    const shortBox = clone(base);
    shortBox.pictures[0].bbox = [1, 2, 3];
    expect(schema.safeParse(shortBox).success).toBe(false);
  });

  it('pins ParseJobRequest to the cl100k_base tokenizer, the known input formats and the token bounds', () => {
    const schema = schemaFor('ParseJobRequest');
    const base = fixture.samples.ParseJobRequest;
    expect(schema.safeParse({ ...base, tokenizer: 'p50k_base' }).success).toBe(false);
    expect(schema.safeParse({ ...base, input_format: 'xlsx' }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_tokens: 63 }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_tokens: 4097 }).success).toBe(false);
    expect(schema.safeParse({ ...base, page_cap: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, input_format: 'json_docling', page_cap: 40 }).success).toBe(true);
  });

  it('accepts each ParseJobState status and rejects an unknown one', () => {
    const schema = schemaFor('ParseJobState');
    for (const status of ['queued', 'running', 'expired']) {
      expect(schema.safeParse({ job_id: 'job-1', status, result: null, error_class: null }).success, status).toBe(true);
    }
    expect(schema.safeParse({ job_id: 'job-1', status: 'paused', result: null, error_class: null }).success).toBe(false);
    const failed = schema.safeParse({ job_id: 'job-1', status: 'failed', result: null, error_class: 'ocr_failed' });
    expect(failed.success).toBe(true);
  });

  it('keeps invoice money as decimal strings and rejects numbers and comma decimals', () => {
    const schema = schemaFor('InvoiceFields');
    const base = fixture.samples.InvoiceFields;
    expect(typeof base.gross_total).toBe('string');
    expect(schema.safeParse({ ...base, gross_total: 122 }).success).toBe(false);
    expect(schema.safeParse({ ...base, gross_total: '1,220.00' }).success).toBe(false);
    expect(schema.safeParse({ ...base, gross_total: '12.34567' }).success).toBe(false);
    expect(schema.safeParse({ ...base, gross_total: '-12.5' }).success).toBe(true);
  });

  it('restricts invoice currency, dates and tax-id schemes', () => {
    const schema = schemaFor('InvoiceFields');
    const base = fixture.samples.InvoiceFields;
    expect(schema.safeParse({ ...base, currency: 'eur' }).success).toBe(false);
    expect(schema.safeParse({ ...base, issue_date: '31/01/2026' }).success).toBe(false);
    expect(schema.safeParse({ ...base, supplier: { ...base.supplier, tax_id_scheme: 'us_ein' } }).success).toBe(false);
    expect(schema.safeParse({ ...base, currency: null, issue_date: null, due_date: null }).success).toBe(true);
  });

  it('carries only the synthetic tax ids in the invoice sample', () => {
    const base = fixture.samples.InvoiceFields;
    expect([base.supplier.tax_id, base.buyer.tax_id].sort()).toEqual(['91000000MA0000000N', '99999999990']);
  });

  it('rejects an empty markdown body on InvoiceExtractRequest', () => {
    const schema = schemaFor('InvoiceExtractRequest');
    expect(schema.safeParse({ markdown: '' }).success).toBe(false);
    expect(schema.safeParse({ markdown: 'x', language_hint: 'fr' }).success).toBe(false);
    expect(schema.safeParse({ markdown: 'x', tables: [], language_hint: 'it' }).success).toBe(true);
  });
});
