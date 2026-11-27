import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@/lib/rag-eval/contracts.generated';
import {
  CondensedQuerySchema,
  QueryPlanSchema,
  QueryTranslationSchema,
  SubQuestionsWithFiltersSchema,
} from '@/lib/rag-eval/contracts.generated';

type SampleFile = {
  samples: Record<string, unknown>;
  variants: Record<string, { model: string; value: unknown }>;
};

type ZodLike = { safeParse: (value: unknown) => { success: boolean; error?: unknown } };

const ROOT = process.cwd();
const samples = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/contracts/samples.json'), 'utf8')) as SampleFile;

function schemaOf(model: string): ZodLike {
  const schema = (contracts as Record<string, unknown>)[`${model}Schema`] as ZodLike | undefined;
  if (!schema) throw new Error(`${model}Schema is not generated`);
  return schema;
}

const NEW_MODELS = [
  'SubQuestionsWithFilters',
  'ScopeGateCalibration',
  'ScopeGateResult',
  'LangidRequest',
  'LangidResponse',
  'QueryAdditionsDecisionRecord',
  'RagTurnMetadata',
];

describe('Phase 6.2 generated contracts (06.2-01, D-29)', () => {
  it.each(NEW_MODELS)('%s sample parses with its generated schema', (model) => {
    expect(samples.samples[model], `${model} sample`).toBeDefined();
    expect(schemaOf(model).safeParse(samples.samples[model]).success).toBe(true);
  });

  it('every Phase 6.2 variant parses with its generated schema', () => {
    const names = ['QueryPlan:phase62', 'RagTrace:phase62', 'RagRunRequest:voice_entry', 'GoldenItem:scoped_compound'];
    for (const name of names) {
      const variant = samples.variants[name];
      expect(variant, name).toBeDefined();
      expect(schemaOf(variant.model).safeParse(variant.value).success, name).toBe(true);
    }
  });

  it('every scripted output of the fake query LLM parses with its transform schema', () => {
    const table = JSON.parse(readFileSync(join(ROOT, 'eval/fixtures/query-llm/transforms.json'), 'utf8')) as {
      entries: Array<{ transform: string; output?: unknown }>;
    };
    const byTransform: Record<string, ZodLike> = {
      condense: CondensedQuerySchema,
      translate: QueryTranslationSchema,
      expand: schemaOf('QueryVariants'),
      decompose: schemaOf('SubQuestions'),
      hyde: schemaOf('HypotheticalDocument'),
    };
    let checked = 0;
    for (const entry of table.entries) {
      if (entry.output === undefined) continue;
      expect(byTransform[entry.transform].safeParse(entry.output).success, `${entry.transform} ${JSON.stringify(entry.output)}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('the generated QueryPlan schema accepts a Phase 6 plan without the new fields', () => {
    const plan = samples.samples.QueryPlan as Record<string, unknown>;
    for (const field of ['sub_question_specs', 'completeness', 'language_detection', 'filter_trace']) expect(plan).not.toHaveProperty(field);
    expect(QueryPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('the filter schema refuses fields outside the allowlist', () => {
    const question = { text: 'What does part alpha state?', filter: { date_range: null, scopes: null, doc_types: null, languages: null } };
    expect(SubQuestionsWithFiltersSchema.safeParse({ questions: [question] }).success).toBe(true);
    const widened = { ...question, filter: { ...question.filter, document_ids: ['00000000-0000-4000-8000-000000000001'] } };
    expect(SubQuestionsWithFiltersSchema.safeParse({ questions: [widened] }).success).toBe(false);
    expect(SubQuestionsWithFiltersSchema.safeParse({ questions: [{ text: 'What does part alpha state?' }] }).success).toBe(false);
  });

  it('condense and translate outputs need their language fields, null allowed', () => {
    expect(CondensedQuerySchema.safeParse({ standalone: 'alpha', unchanged: true, language: null }).success).toBe(true);
    expect(CondensedQuerySchema.safeParse({ standalone: 'alpha', unchanged: true }).success).toBe(false);
    expect(QueryTranslationSchema.safeParse({ target_language: 'it', text: 'alfa', source_language: null }).success).toBe(true);
    expect(QueryTranslationSchema.safeParse({ target_language: 'it', text: 'alfa' }).success).toBe(false);
  });
});
