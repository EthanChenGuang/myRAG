import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';

const lang = vi.hoisted(() => ({ current: 'en' }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: lang.current, setLanguage: () => {}, t: (key: string) => key }),
}));

const { GroundednessBadge } = await import('@/components/ui/groundedness-badge');
const { useAnswerRecordsStore } = await import('@/lib/stores/answer-records-store');
const { answerQualityStrings } = await import('@/translations/answer-quality');
type AnswerRecord = import('@/lib/rag-eval/contracts.generated').AnswerRecord;

const ANSWER_ID = '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f';
const groundedness = { checkedAt: null, label: 'verified', latencyMs: 12, reason: null, score: 0.8, scorer: 'hhem_2_1_open', status: 'scored', threshold: 0.5, thresholdSource: 'default', truncated: false } as AnswerRecord['groundedness'];
function record(overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    answerId: ANSWER_ID, answerLanguage: 'en', chatId: '22222222-2222-4222-8222-222222222222', citationStrategy: null,
    createdAt: '2026-11-25T09:00:00.000Z', feedback: null, feedbackEnabled: true, groundedness, invalidCitations: 0,
    modelId: 'test/model', ragMode: 'strict', traceId: 'trace-1', updatedAt: '2026-11-25T09:00:00.000Z', ...overrides,
  };
}
const serverRecords = useAnswerRecordsStore.getInitialState().records;
const put = (r: AnswerRecord) => { serverRecords[r.answerId] = r; };
const badge = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(GroundednessBadge, { answerId: ANSWER_ID, ...props }) as ReactNode as never);

beforeEach(() => {
  lang.current = 'en';
  for (const key of Object.keys(serverRecords)) delete serverRecords[key];
});

describe('GroundednessBadge text source (UI-SPEC 6.8)', () => {
  test('textsSource registry with a zh answer shows the zh registry label and tooltip with lang, in an en UI', () => {
    put(record({ textsSource: 'registry', answerLanguage: 'zh' }));
    const html = badge();
    expect(html).toContain(`<span>${FIXED_TEXTS.zh.labels.badge_verified}</span>`);
    expect(html).toContain(`: ${FIXED_TEXTS.zh.labels.badge_tooltip_verified}`);
    expect(html).toContain('lang="zh"');
    expect(html).toContain('data-groundedness-badge="verified"');
    expect(html).toContain('bg-emerald-50');
  });

  test('registry texts in the UI language carry no lang', () => {
    put(record({ textsSource: 'registry', answerLanguage: 'en' }));
    const html = badge();
    expect(html).toContain(`<span>${FIXED_TEXTS.en.labels.badge_verified}</span>`);
    expect(html).not.toContain('lang=');
  });

  test('a legacy record or no textsSource shows today\'s UI-language strings', () => {
    lang.current = 'it';
    const today = answerQualityStrings('it');
    put(record({ textsSource: 'legacy', answerLanguage: 'zh' }));
    const legacy = badge();
    expect(legacy).toContain(`<span>${today.badgeLabels.verified}</span>`);
    expect(legacy).not.toContain('lang=');
    put(record({ answerLanguage: 'zh' }));
    expect(badge()).toBe(legacy);
  });

  test('no record (shared chat) shows today\'s strings from the fallback', () => {
    const html = badge({ fallback: groundedness });
    expect(html).toContain(`<span>${answerQualityStrings('en').badgeLabels.verified}</span>`);
  });
});
