import { describe, expect, it } from 'vitest';
import type { z } from 'zod/v3';
import type { TerminologyLexicon as ExportedLexicon } from '@/lib/rag';
import {
  TerminologyLexiconSchema,
  TerminologyLexiconTermSchema,
  TerminologyTranslationPairSchema,
  type TerminologyLexicon,
} from '@/lib/rag-eval/contracts.generated';

/**
 * D-33 shape lock. Phases 4.2 (LANG-07) and 6.2 (XLG-05) build on this contract: changing it means changing the Pydantic model,
 * regenerating the Zod and updating these expected lists in one commit.
 */
type Shape = Record<string, string>;

function typeName(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName: string; type?: z.ZodTypeAny; innerType?: z.ZodTypeAny };
  if (def.typeName === 'ZodArray') return `array<${typeName(def.type!)}>`;
  if (def.typeName === 'ZodOptional') return `optional<${typeName(def.innerType!)}>`;
  if (def.typeName === 'ZodObject') return 'object';
  return def.typeName.replace(/^Zod/, '').toLowerCase();
}

function shapeOf(schema: z.AnyZodObject): Shape {
  return Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([key, value]) => [key, typeName(value)]));
}

describe('TerminologyLexicon contract (D-33)', () => {
  it('locks the top-level fields and types', () => {
    expect(shapeOf(TerminologyLexiconSchema)).toEqual({
      version: 'string',
      entries_sha256: 'string',
      terms: 'array<object>',
      translations: 'array<object>',
    });
  });

  it('locks the term fields and types', () => {
    expect(shapeOf(TerminologyLexiconTermSchema)).toEqual({ normalized: 'string', language: 'enum', kind: 'enum' });
    expect(shapeOf(TerminologyLexiconSchema.shape.terms.element)).toEqual(shapeOf(TerminologyLexiconTermSchema));
    expect([...TerminologyLexiconTermSchema.shape.kind.options].sort()).toEqual(
      ['abbreviation', 'alias', 'identifier', 'misspelling', 'synonym', 'translation'].sort(),
    );
    expect(TerminologyLexiconTermSchema.shape.language.options).toContain('any');
  });

  it('locks the translation pair fields and types', () => {
    expect(shapeOf(TerminologyTranslationPairSchema)).toEqual({
      entry_id: 'string',
      source_language: 'enum',
      target_language: 'enum',
      sources: 'array<string>',
      target: 'string',
      target_normalized: 'string',
    });
    expect(shapeOf(TerminologyLexiconSchema.shape.translations.element)).toEqual(shapeOf(TerminologyTranslationPairSchema));
    expect(TerminologyTranslationPairSchema.shape.source_language.options).not.toContain('any');
  });

  it('is strict: an unknown field is rejected', () => {
    const sample = {
      version: 's1.w0',
      entries_sha256: 'a'.repeat(64),
      terms: [],
      translations: [],
    };
    expect(() => TerminologyLexiconSchema.parse(sample)).not.toThrow();
    expect(() => TerminologyLexiconSchema.parse({ ...sample, extra: 1 })).toThrow();
    expect(() => TerminologyLexiconSchema.parse({ ...sample, version: 's1' })).toThrow();
  });

  it('@/lib/rag exports the read API and its error', async () => {
    const rag = await import('@/lib/rag');
    const lexicon = await import('@/lib/rag/terminology/lexicon');
    expect(rag.getTerminologyLexicon).toBe(lexicon.getTerminologyLexicon);
    expect(rag.TerminologyUnavailableError).toBe(lexicon.TerminologyUnavailableError);
  });

  it('a sample result parses, and the exported type is the generated one', () => {
    const [source, target] = TerminologyTranslationPairSchema.shape.source_language.options;
    const sample: ExportedLexicon = {
      version: 's2.w1',
      entries_sha256: '0'.repeat(64),
      terms: [
        { normalized: 'term alpha beta', language: target!, kind: 'synonym' },
        { normalized: 'termalpha', language: 'any', kind: 'alias' },
      ],
      translations: [
        {
          entry_id: '00000000-0000-4000-8000-000000000001',
          source_language: source!,
          target_language: target!,
          sources: ['术语甲乙丙'],
          target: 'term alpha beta',
          target_normalized: 'term alpha beta',
        },
      ],
    };
    const parsed: TerminologyLexicon = TerminologyLexiconSchema.parse(sample);
    expect(parsed).toEqual(sample);
  });
});
