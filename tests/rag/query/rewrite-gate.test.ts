import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectGateLanguage } from '@/lib/rag/query/gate-language';
import { queryLanguage } from '@/lib/rag/query/language';
import { GATE_RULE_IDS, matchRelativeTime, needsRewrite, type GateContext } from '@/lib/rag/query/rewrite-gate';
import { GATE_FIXTURES } from './rewrite-gate.fixtures';

const NOW = new Date('2026-11-25T10:00:00Z');
const LLM_TRANSFORMS = new Set(['condense_history', 'decompose', 'expand', 'translate']);

function gate(q: string, ctx: Partial<GateContext> = {}) {
  return needsRewrite(q, { hasHistory: false, now: NOW, ...ctx });
}

describe('needsRewrite: spec fixture table', () => {
  it.each(GATE_FIXTURES.map((f) => [`${f.name} [${f.lang}] ${f.q}`, f] as const))('%s', (_label, f) => {
    const result = needsRewrite(f.q, { ...f.ctx, now: NOW });
    expect(result.transforms).toEqual(f.transforms);
    expect(result.rewrite).toBe(f.transforms.some((t) => LLM_TRANSFORMS.has(t)));
    expect(result.lang).toBe(f.lang);
    if (f.reason) expect(result.reasons).toContain(f.reason);
    if (f.protectedTokens) expect(result.protectedTokens).toEqual(f.protectedTokens);
    expect(Boolean(result.skipRetrieval)).toBe(Boolean(f.skipRetrieval));
  });
});

describe('needsRewrite: rules', () => {
  it('exports thirteen stable rule ids and only reports those', () => {
    expect(GATE_RULE_IDS).toHaveLength(13);
    expect(new Set(GATE_RULE_IDS).size).toBe(13);
    for (const f of GATE_FIXTURES) {
      for (const reason of needsRewrite(f.q, { ...f.ctx, now: NOW }).reasons) {
        expect(GATE_RULE_IDS).toContain(reason);
      }
    }
  });

  it('returns every rule that fired: R1 and R4 together for a follow-up with a code', () => {
    const result = gate('那个 ERR_TIMEOUT 怎么修？', { hasHistory: true });
    expect(result.reasons).toEqual(expect.arrayContaining(['R1_PRONOUN', 'R4_EXACT_CODE']));
    expect(result.transforms).toEqual(['condense_history']);
    expect(result.protectedTokens).toEqual(['ERR_TIMEOUT']);
    expect(result.rewrite).toBe(true);
  });

  it('fires R1 and R5 only with history', () => {
    expect(gate('那意大利呢？').reasons).not.toContain('R5_ELLIPTICAL');
    expect(gate('How long is its warranty?').reasons).not.toContain('R1_PRONOUN');
  });

  it('matches 该 at the start or before a noun, never inside 应该', () => {
    expect(gate('该产品的保修期多久？', { hasHistory: true }).reasons).toContain('R1_PRONOUN');
    expect(gate('该怎么申请退款呢', { hasHistory: true }).reasons).toContain('R1_PRONOUN');
    expect(gate('应该怎么申请？', { hasHistory: true }).reasons).not.toContain('R1_PRONOUN');
    expect(gate('我们应该提交哪些材料才能报销？', { hasHistory: true }).reasons).not.toContain('R1_PRONOUN');
  });

  it('normalizes Italian elisions and curly apostrophes', () => {
    expect(gate("Fatturato l'anno scorso per regione").reasons).toContain('R2_RELATIVE_TIME');
    expect(gate('Fatturato l’anno scorso per regione').reasons).toContain('R2_RELATIVE_TIME');
    expect(gate("Quanto abbiamo venduto quest'anno in Italia?").reasons).toContain('R2_RELATIVE_TIME');
  });

  it('does not read a relative-time phrase as a pronoun', () => {
    const zh = gate('这个月的营收是多少？', { hasHistory: true });
    expect(zh.reasons).toEqual(['R2_RELATIVE_TIME']);
    expect(zh.transforms).toEqual(['normalize_dates']);
    expect(gate('What was revenue this year?', { hasHistory: true }).reasons).not.toContain('R1_PRONOUN');
  });

  it('maps relative time to structured lexicon entries for date normalization', () => {
    expect(matchRelativeTime('去年的营收是多少？')).toEqual([{ term: '去年', unit: 'year', offset: -1 }]);
    expect(matchRelativeTime('What was revenue last year?')).toEqual([{ term: 'last year', unit: 'year', offset: -1 }]);
    expect(matchRelativeTime("Qual è stato il fatturato l'anno scorso?")).toEqual([
      { term: "l'anno scorso", unit: 'year', offset: -1 },
    ]);
    expect(matchRelativeTime('近30天的订单')).toEqual([{ term: '近N天', unit: 'day', offset: null, n: 30 }]);
    expect(matchRelativeTime('orders in the past 7 days')).toEqual([
      { term: 'past N days', unit: 'day', offset: null, n: 7 },
    ]);
    expect(gate('近30天的订单有多少？').transforms).toEqual(['normalize_dates']);
  });

  it('R4: a code alone is short, so it is expanded but still protected', () => {
    const result = gate('ERR_TIMEOUT');
    expect(result.transforms).toEqual(['expand']);
    expect(result.reasons).toEqual(expect.arrayContaining(['R0_TOO_SHORT', 'R4_EXACT_CODE']));
    expect(result.protectedTokens).toEqual(['ERR_TIMEOUT']);
  });

  it('R4: a complete query with a code is not rewritten and not expanded', () => {
    const keywords = gate('ERR_TIMEOUT retry settings');
    expect(keywords.transforms).toEqual([]);
    expect(keywords.rewrite).toBe(false);
    expect(keywords.protectedTokens).toEqual(['ERR_TIMEOUT']);
  });

  it('R7: literals are protected and reported', () => {
    const result = gate('Is the limit «€1,200» per night since 2026-03-01?');
    expect(result.reasons).toContain('R7_PROTECTED_LITERAL');
    expect(result.protectedTokens).toEqual(['€1,200', '2026-03-01']);
  });

  it('R8: fires on kbLang mismatch, not on a match', () => {
    expect(gate('What is the hotel reimbursement limit?', { kbLang: 'zh' }).transforms).toEqual(['translate']);
    expect(gate('What is the hotel reimbursement limit?', { kbLang: 'en' }).reasons).not.toContain(
      'R8_LANGUAGE_MISMATCH'
    );
    expect(gate('What is the hotel reimbursement limit?').reasons).not.toContain('R8_LANGUAGE_MISMATCH');
  });

  it('R8: with kbShares, fires when the query language share is at most 0.2', () => {
    const q = 'What is the hotel reimbursement limit?';
    expect(gate(q, { kbShares: { zh: 0.85, en: 0.15 } }).transforms).toEqual(['translate']);
    expect(gate(q, { kbShares: { zh: 0.8, en: 0.2 } }).transforms).toEqual(['translate']);
    expect(gate(q, { kbShares: { zh: 0.6, en: 0.4 } }).reasons).not.toContain('R8_LANGUAGE_MISMATCH');
    expect(gate(q, { kbShares: { zh: 1 } }).transforms).toEqual(['translate']);
    expect(gate(q, { kbShares: {} }).reasons).not.toContain('R8_LANGUAGE_MISMATCH');
  });

  it('R6: compound markers and two question marks decompose', () => {
    expect(gate('退款政策是什么？需要多久？').transforms).toEqual(['decompose']);
    expect(gate('What is the refund window and also who pays return shipping?').reasons).toContain('R6_COMPOUND');
    expect(gate('Qual è la garanzia e inoltre chi paga la spedizione?').transforms).toEqual(['decompose']);
  });

  it('R10: vague questions expand, but not when R4 fired', () => {
    expect(gate('tell me about the refund policy').transforms).toEqual(['expand']);
    expect(gate('parlami di garanzia e resi').reasons).toContain('R10_VAGUE');
    const withCode = gate('tell me about ERR_TIMEOUT handling');
    expect(withCode.reasons).not.toContain('R10_VAGUE');
    expect(withCode.transforms).toEqual([]);
  });

  it('R11 suppresses expand and decompose for a long complete question', () => {
    const result = gate(
      'overview of the hotel reimbursement rules for employees travelling on business in Europe during the peak season'
    );
    expect(result.reasons).toContain('R11_LONG_COMPLETE');
    expect(result.transforms).toEqual([]);
  });

  it('R11 does not fire when a comparison makes the long question decompose', () => {
    const result = gate(
      'What is the difference between the hotel reimbursement limit for employees and the limit for managers on long business trips?'
    );
    expect(result.reasons).not.toContain('R11_LONG_COMPLETE');
    expect(result.transforms).toEqual(['decompose']);
  });

  it('R12 needs small talk to be the whole query', () => {
    expect(gate('Grazie mille').skipRetrieval).toBe(true);
    const mixed = gate('thanks, what is the refund window?');
    expect(mixed.skipRetrieval).toBeFalsy();
    expect(mixed.reasons).not.toContain('R12_SMALL_TALK');
  });

  it('normalize_dates alone is not a rewrite', () => {
    const result = gate('What was revenue last year?');
    expect(result.transforms).toEqual(['normalize_dates']);
    expect(result.rewrite).toBe(false);
  });

  it('is pure: same input gives the same result and ctx is not mutated', () => {
    const ctx: GateContext = { hasHistory: true, now: NOW, kbShares: { zh: 0.9, en: 0.1 } };
    const snapshot = JSON.stringify(ctx);
    const a = needsRewrite('那个 ERR_TIMEOUT 怎么修？', ctx);
    const b = needsRewrite('那个 ERR_TIMEOUT 怎么修？', ctx);
    expect(a).toEqual(b);
    expect(JSON.stringify(ctx)).toBe(snapshot);
  });
});

describe('gate language vs Phase 4 queryLanguage on the golden set', () => {
  it('agrees with the golden language on at least 95% of items and reports detector differences', () => {
    const goldenPath = path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
      'eval/fixtures/golden.jsonl'
    );
    const rows = fs
      .readFileSync(goldenPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; question: string; language: string });

    let agreed = 0;
    const differing: string[] = [];
    for (const row of rows) {
      const gateLang = detectGateLanguage(row.question);
      if (gateLang === row.language) agreed += 1;
      const phase4 = queryLanguage(row.question);
      if (phase4 !== gateLang) differing.push(`${row.id} gate=${gateLang} phase4=${phase4 ?? 'null'}`);
    }
    console.log('[Query Layer] gate vs Phase 4 language detector differences:', {
      agreementWithGolden: `${agreed}/${rows.length}`,
      differing,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(agreed / rows.length).toBeGreaterThanOrEqual(0.95);
  });
});
