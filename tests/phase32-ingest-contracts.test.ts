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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const variantsOf = (model: string) =>
  Object.entries(fixture.variants ?? {}).filter(([, entry]) => entry.model === model);

const hiddenTextReason = () => ({
  kind: 'hidden_text',
  detail: '2 hidden spans',
  spans: [
    { page: 1, text: 'Synthetic hidden sentence one.', reason: 'color_near_background' },
    { page: 2, text: 'Synthetic hidden sentence two.', reason: 'font_too_small' },
  ],
  checker_version: 'hidden-text@1',
});

describe('QuarantineReason generated from Pydantic', () => {
  it('accepts a hidden_text reason with two spans and defaults unlocated to 0', () => {
    const parsed = schemaFor('QuarantineReason').safeParse(hiddenTextReason());
    expect(parsed.success).toBe(true);
    expect(parsed.data.unlocated).toBe(0);
    expect(parsed.data.spans).toHaveLength(2);
  });

  it('rejects an unknown kind, a hidden_text reason with targets only, empty spans and an extra key', () => {
    const schema = schemaFor('QuarantineReason');
    expect(schema.safeParse({ ...hiddenTextReason(), kind: 'other' }).success).toBe(false);
    const { spans: _spans, ...withoutSpans } = hiddenTextReason();
    expect(schema.safeParse({ ...withoutSpans, targets: ['outside.example.net'] }).success).toBe(false);
    expect(schema.safeParse({ ...hiddenTextReason(), spans: [] }).success).toBe(false);
    expect(schema.safeParse({ ...hiddenTextReason(), unexpected_key: 1 }).success).toBe(false);
    const span = clone(hiddenTextReason());
    (span.spans[0] as Record<string, unknown>).unexpected_key = 1;
    expect(schema.safeParse(span).success).toBe(false);
  });

  it('rejects an untrusted_link reason without targets', () => {
    const schema = schemaFor('QuarantineReason');
    const link = { kind: 'untrusted_link', detail: '1 target', targets: ['outside.example.net'], checker_version: 'link-check@1' };
    expect(schema.safeParse(link).success).toBe(true);
    expect(schema.safeParse({ ...link, targets: [] }).success).toBe(false);
    const { targets: _targets, ...withoutTargets } = link;
    expect(schema.safeParse(withoutTargets).success).toBe(false);
  });

  it('has one named sample variant per kind, each parsing unchanged', () => {
    const variants = variantsOf('QuarantineReason');
    expect(variants.map(([, entry]) => entry.value.kind).sort()).toEqual(
      ['hidden_text', 'injection_rule', 'invoice_extraction', 'untrusted_link'],
    );
    for (const [name, entry] of variants) {
      expect(name).toBe(`QuarantineReason:${entry.value.kind}`);
      const parsed = schemaFor('QuarantineReason').safeParse(entry.value);
      expect(parsed.success, name).toBe(true);
      expect(parsed.data).toEqual(entry.value);
    }
  });
});
