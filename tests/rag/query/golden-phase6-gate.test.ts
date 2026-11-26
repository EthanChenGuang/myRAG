import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ZodType, ZodTypeDef } from 'zod/v3';
import {
  CondensedQuerySchema,
  QueryTranslationSchema,
  SubQuestionsSchema,
} from '@/lib/rag-eval/contracts.generated';
import { needsRewrite, type GateResult } from '@/lib/rag/query/rewrite-gate';
import type { QueryLlmTransform } from '@/lib/rag/query/llm';
import { createFakeQueryLlm, loadFakeQueryLlmTable } from '../../../eval/harness/fake-query-llm.mts';

// Plan 06-38: each Phase 6 golden item fires the gate rule it is meant to exercise, and the fake query LLM
// keeps every protected token the gate reports.

type Item = {
  id: string;
  category: string;
  question: string;
  conversation: unknown[];
  tags?: string[];
};

const NOW = new Date('2026-11-25T10:00:00Z');
const ZH_HEAVY = { zh: 0.9, en: 0.05, it: 0.05 };
const table = loadFakeQueryLlmTable(join(process.cwd(), 'eval/fixtures/query-llm/transforms.json'));
const llm = createFakeQueryLlm({ table });
const items: Item[] = readFileSync(join(process.cwd(), 'eval/fixtures/golden.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Item);

function tagged(tag: string): Item[] {
  const found = items.filter((item) => item.tags?.includes(tag));
  expect(found.length).toBeGreaterThanOrEqual(6);
  return found;
}

function gate(item: Item, kbShares?: Record<string, number>): GateResult {
  return needsRewrite(item.question, { hasHistory: item.conversation.length > 0, now: NOW, ...(kbShares ? { kbShares } : {}) });
}

function generate<T>(transform: QueryLlmTransform, schema: ZodType<unknown, ZodTypeDef, unknown>, input: string, targetLanguage?: 'zh') {
  return llm.generate({
    transform,
    schema: schema as ZodType<T, ZodTypeDef, unknown>,
    system: 'system',
    prompt: 'prompt',
    input,
    signal: new AbortController().signal,
    ...(targetLanguage ? { targetLanguage } : {}),
  });
}

describe('Phase 6 golden items against the rewrite gate', () => {
  test('protected-code follow-ups fire R1 and R4, condense, and the scripted rewrite keeps every protected token', async () => {
    for (const item of tagged('phase6_protected_followup')) {
      const result = gate(item);
      expect(result.reasons, item.id).toEqual(expect.arrayContaining(['R1_PRONOUN', 'R4_EXACT_CODE']));
      expect(result.transforms, item.id).toContain('condense_history');
      const out = await generate<{ standalone: string; unchanged: boolean }>('condense', CondensedQuerySchema, item.question);
      expect(out.unchanged, item.id).toBe(false);
      for (const token of result.protectedTokens) expect(out.standalone, `${item.id}|${token}`).toContain(token);
    }
  });

  test('elliptical follow-ups fire R5 and condense', () => {
    for (const item of tagged('phase6_elliptical')) {
      const result = gate(item);
      expect(result.reasons, item.id).toContain('R5_ELLIPTICAL');
      expect(result.transforms, item.id).toContain('condense_history');
    }
  });

  test('relative-time follow-ups fire R2 and normalize dates next to condense', () => {
    for (const item of tagged('phase6_relative_time')) {
      const result = gate(item);
      expect(result.reasons, item.id).toContain('R2_RELATIVE_TIME');
      expect(result.transforms, item.id).toEqual(expect.arrayContaining(['condense_history', 'normalize_dates']));
    }
  });

  test('compound items decompose into three or four scripted parts', async () => {
    for (const item of tagged('phase6_compound')) {
      expect(gate(item).transforms, item.id).toContain('decompose');
      const out = await generate<{ questions: string[] }>('decompose', SubQuestionsSchema, item.question);
      expect(out.questions.length, item.id).toBeGreaterThanOrEqual(3);
      expect(out.questions.length, item.id).toBeLessThanOrEqual(4);
    }
  });

  test('cross-language items translate to zh on a zh-heavy knowledge base and keep protected tokens', async () => {
    for (const item of tagged('phase6_cross_lingual')) {
      const result = gate(item, ZH_HEAVY);
      expect(result.transforms, item.id).toContain('translate');
      const out = await generate<{ target_language: string; text: string }>('translate', QueryTranslationSchema, item.question, 'zh');
      expect(out.target_language).toBe('zh');
      expect(out.text, item.id).not.toBe('');
      for (const token of result.protectedTokens) expect(out.text, `${item.id}|${token}`).toContain(token);
    }
  });

  test('small talk skips retrieval without any rewrite', () => {
    const smallTalk = items.filter((item) => item.category === 'small_talk');
    expect(smallTalk.length).toBeGreaterThanOrEqual(6);
    for (const item of smallTalk) {
      const result = gate(item);
      expect(result.skipRetrieval, item.id).toBe(true);
      expect(result.transforms, item.id).toEqual([]);
    }
  });
});
