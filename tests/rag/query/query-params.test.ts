import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryParamsSchema } from '@/lib/rag-eval/contracts.generated';
import { effectiveQueryParams, parseCommittedQueryParams, resetQueryParamsWarningsForTests } from '@/lib/rag/query/query-params';

const LIMIT_FIELDS = [
  'group_deadline_ms',
  'history_turn_chars',
  'history_turns',
  'max_llm_variants',
  'max_searches',
  'max_sub_questions',
  'max_translations',
  'variant_max_chars',
  'variant_max_ratio',
] as const;

function committedFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), 'eval/config/query-params.json'), 'utf8')) as Record<string, unknown>;
}

describe('effectiveQueryParams (D-08)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetQueryParamsWarningsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function queryLayerWarnings(): unknown[][] {
    return warn.mock.calls.filter((call: unknown[]) => String(call[0]).startsWith('[Query Layer]'));
  }

  test('the committed file loads and equals the QueryParams defaults', () => {
    const defaults = QueryParamsSchema.parse({});
    const params = effectiveQueryParams('chat');
    for (const field of LIMIT_FIELDS) expect(params[field]).toBe(defaults[field]);
    expect(params.query_budget_ms).toEqual({ chat: 1200, embed: 1200, voice: 300 });
    expect(params).toEqual(QueryParamsSchema.parse(committedFile()));
    expect(queryLayerWarnings()).toHaveLength(0);
  });

  test('eval overrides apply for the eval profile and are ignored for chat', () => {
    expect(effectiveQueryParams('eval', { max_sub_questions: 2 }).max_sub_questions).toBe(2);
    for (const profile of ['chat', 'embed', 'voice', 'media'] as const) {
      expect(effectiveQueryParams(profile, { max_sub_questions: 2 }).max_sub_questions).toBe(4);
    }
    expect(effectiveQueryParams('eval', { max_sub_questions: null, max_translations: 1 })).toMatchObject({ max_sub_questions: 4, max_translations: 1 });
  });

  test('nested query budget overrides change only the named entry profile', () => {
    const params = effectiveQueryParams('eval', { query_budget_ms: { chat: 2000, embed: null, voice: null } });
    expect(params.query_budget_ms).toEqual({ chat: 2000, embed: 1200, voice: 300 });
  });

  test('an invalid override keeps the previous valid value and logs one [Query Layer] warning', () => {
    const params = effectiveQueryParams('eval', { max_searches: 9, max_sub_questions: 3 });
    expect(params.max_searches).toBe(8);
    expect(params.max_sub_questions).toBe(3);
    effectiveQueryParams('eval', { max_searches: 9 });
    expect(queryLayerWarnings()).toHaveLength(1);
    expect(JSON.stringify(queryLayerWarnings()[0])).toContain('max_searches');
  });

  test('an invalid nested budget override keeps the previous value', () => {
    const params = effectiveQueryParams('eval', { query_budget_ms: { chat: 0, embed: 900, voice: null } });
    expect(params.query_budget_ms).toEqual({ chat: 1200, embed: 900, voice: 300 });
    expect(queryLayerWarnings()).toHaveLength(1);
  });

  test('a returned value is a copy: mutating it never changes the committed limits', () => {
    const first = effectiveQueryParams('chat');
    first.max_searches = 1;
    if (first.query_budget_ms) first.query_budget_ms.chat = 1;
    const second = effectiveQueryParams('chat');
    expect(second.max_searches).toBe(8);
    expect(second.query_budget_ms?.chat).toBe(1200);
  });

  test('an invalid committed file falls back to the QueryParams defaults with one warning', () => {
    const parsed = parseCommittedQueryParams({ ...committedFile(), max_searches: 99 });
    expect(parsed).toEqual(QueryParamsSchema.parse({}));
    parseCommittedQueryParams({ ...committedFile(), max_searches: 99 });
    expect(queryLayerWarnings()).toHaveLength(1);
    expect(parseCommittedQueryParams({ ...committedFile(), max_searches: 5 }).max_searches).toBe(5);
  });
});
