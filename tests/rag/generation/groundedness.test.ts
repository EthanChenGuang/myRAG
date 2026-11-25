import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowVectaraFor,
  answerGroundednessLanguage,
  buildHypothesis,
  buildPremise,
  groundednessEligibility,
  labelGroundedness,
  loadGroundednessThresholds,
  loadGroundednessThresholdsFromData,
  type GroundednessEligibilityInput,
} from '@/lib/rag/generation/groundedness';
import type { AliasedBlock } from '@/lib/rag/generation/citations/blocks';
import type { GroundednessResult } from '@/lib/rag-eval/contracts.generated';

afterEach(() => {
  vi.restoreAllMocks();
});

const eligibleInput: GroundednessEligibilityInput = {
  enabled: true,
  webChatWithCitations: true,
  ragMode: 'strict',
  retrievalStatus: 'ok',
  blockCount: 2,
  isRefusal: false,
  ghostChat: false,
  toolOutputUsed: false,
};

describe('groundednessEligibility', () => {
  it('is eligible when every D-14 condition holds, in strict and balanced mode', () => {
    expect(groundednessEligibility(eligibleInput)).toEqual({ eligible: true });
    expect(groundednessEligibility({ ...eligibleInput, ragMode: 'balanced' })).toEqual({ eligible: true });
    expect(groundednessEligibility({ ...eligibleInput, retrievalStatus: 'degraded' })).toEqual({ eligible: true });
  });

  const missing: Array<[string, Partial<GroundednessEligibilityInput>]> = [
    ['switch off', { enabled: false }],
    ['no citations capability or not the web chat', { webChatWithCitations: false }],
    ['flexible mode', { ragMode: 'flexible' }],
    ['bypass mode', { ragMode: 'bypass' }],
    ['unknown mode', { ragMode: '' }],
    ['empty retrieval', { retrievalStatus: 'empty' }],
    ['retrieval error', { retrievalStatus: 'error' }],
    ['ok without blocks', { blockCount: 0 }],
    ['degraded without blocks', { retrievalStatus: 'degraded', blockCount: 0 }],
    ['refusal answer', { isRefusal: true }],
    ['ghost chat', { ghostChat: true }],
  ];
  for (const [name, change] of missing) {
    it(`is not eligible on ${name}`, () => {
      expect(groundednessEligibility({ ...eligibleInput, ...change })).toEqual({ eligible: false, reason: 'not_eligible' });
    });
  }

  it('gives tool_output when an MCP tool result was used', () => {
    expect(groundednessEligibility({ ...eligibleInput, toolOutputUsed: true })).toEqual({
      eligible: false,
      reason: 'tool_output',
    });
  });

  it('never scores flexible or bypass, even with a tool result', () => {
    for (const ragMode of ['flexible', 'bypass']) {
      expect(groundednessEligibility({ ...eligibleInput, ragMode, toolOutputUsed: true })).toEqual({
        eligible: false,
        reason: 'not_eligible',
      });
    }
  });
});

function block(alias: string, text: string): AliasedBlock {
  return {
    documentId: `doc-${alias}`,
    documentName: `Doc ${alias}`,
    documentVersion: 1,
    chunkIds: [`chunk-${alias}`],
    page: null,
    sectionPath: null,
    title: `Doc ${alias}`,
    text,
    isImage: false,
    alias,
  };
}

/** Token count is the number in the text after "#" (a fake counter keeps the sizes exact). */
const fakeCount = (text: string): number => Number(/#(\d+)/.exec(text)?.[1] ?? 0);

describe('buildPremise', () => {
  const blocks = [block('S1', 'one #1000'), block('S2', 'two #1000'), block('S3', 'three #1000')];

  it('keeps the cited block first, fills in alias order, drops the rest and sets truncated', () => {
    const premise = buildPremise({
      blocks,
      citedAliases: ['S2'],
      webSearchTexts: ['web #500'],
      maxTokens: 2000,
      countTokens: fakeCount,
    });
    expect(premise).toEqual({ status: 'ok', premiseTexts: ['one #1000', 'two #1000'], truncated: true });
  });

  it('keeps a cited later block over an uncited earlier one', () => {
    const premise = buildPremise({
      blocks,
      citedAliases: ['S3'],
      webSearchTexts: [],
      maxTokens: 1500,
      countTokens: fakeCount,
    });
    expect(premise).toEqual({ status: 'ok', premiseTexts: ['three #1000'], truncated: true });
  });

  it('returns too_long when the cited blocks alone exceed the cap', () => {
    const premise = buildPremise({
      blocks: [block('S1', 'one #1500'), block('S2', 'two #1500')],
      citedAliases: ['S1', 'S2'],
      webSearchTexts: [],
      maxTokens: 2000,
      countTokens: fakeCount,
    });
    expect(premise).toEqual({ status: 'too_long' });
  });

  it('returns every block then the web texts in order under the cap', () => {
    const premise = buildPremise({
      blocks,
      citedAliases: ['S1'],
      webSearchTexts: ['web a #100', 'web b #100'],
      maxTokens: 5000,
      countTokens: fakeCount,
    });
    expect(premise).toEqual({
      status: 'ok',
      premiseTexts: ['one #1000', 'two #1000', 'three #1000', 'web a #100', 'web b #100'],
      truncated: false,
    });
  });

  it('ignores cited aliases that were never sent and skips empty texts', () => {
    const premise = buildPremise({
      blocks: [block('S1', 'one #10'), block('S2', '   ')],
      citedAliases: ['S9'],
      webSearchTexts: [''],
      maxTokens: 100,
      countTokens: fakeCount,
    });
    expect(premise).toEqual({ status: 'ok', premiseTexts: ['one #10'], truncated: false });
  });

  it('returns empty_premise when nothing with text was sent', () => {
    expect(buildPremise({ blocks: [], citedAliases: [], webSearchTexts: [], maxTokens: 100, countTokens: fakeCount })).toEqual({
      status: 'empty_premise',
    });
  });

  it('counts with cl100k by default', () => {
    const premise = buildPremise({
      blocks: [block('S1', 'word '.repeat(300)), block('S2', 'short text')],
      citedAliases: [],
      webSearchTexts: [],
      maxTokens: 50,
    });
    expect(premise).toEqual({ status: 'ok', premiseTexts: ['short text'], truncated: true });
  });
});

describe('buildHypothesis', () => {
  it('strips every marker form and trims', () => {
    const answer = ' Leave is 20 days [S1]. Claims close in 30 days【S2】 and 【S1、S3】 apply［S4］; see [S1, S2] and [S2，S3]. ';
    const result = buildHypothesis(answer);
    expect(result).toEqual({ status: 'ok', hypothesis: 'Leave is 20 days. Claims close in 30 days and apply; see and.' });
    if (result.status === 'ok') expect(result.hypothesis).not.toMatch(/S\d/);
  });

  it('gives empty_answer when only markers or whitespace remain', () => {
    expect(buildHypothesis('[S1] [S2]')).toEqual({ status: 'not_checked', reason: 'empty_answer' });
    expect(buildHypothesis('   ')).toEqual({ status: 'not_checked', reason: 'empty_answer' });
  });
});

describe('answerGroundednessLanguage', () => {
  it('splits answers into en, it, zh-Hans, zh-Hant and unknown', () => {
    expect(answerGroundednessLanguage('The policy says that employees have twenty days of leave [S1].')).toBe('en');
    expect(answerGroundednessLanguage('La politica prevede che i dipendenti hanno venti giorni di ferie per anno.')).toBe('it');
    expect(answerGroundednessLanguage('根据文件说明，员工应该在三个工作日内完成报销申请【S1】。')).toBe('zh-Hans');
    expect(answerGroundednessLanguage('根據文件說明，員工應該在三個工作日內完成報銷申請【S1】。')).toBe('zh-Hant');
    expect(answerGroundednessLanguage('12345 — !!!')).toBe('unknown');
  });

  it('does not treat Chinese without script-specific characters as zh-Hans', () => {
    expect(answerGroundednessLanguage('中文')).toBe('zh');
  });
});

describe('allowVectaraFor', () => {
  it('fails closed unless opted in, and needs the acknowledgement in multi-tenant mode', () => {
    expect(allowVectaraFor({ vectaraOptIn: false, vectaraMultiTenantAck: true }, false)).toBe(false);
    expect(allowVectaraFor({ vectaraOptIn: false, vectaraMultiTenantAck: true }, true)).toBe(false);
    expect(allowVectaraFor({ vectaraOptIn: true, vectaraMultiTenantAck: false }, false)).toBe(true);
    expect(allowVectaraFor({ vectaraOptIn: true, vectaraMultiTenantAck: false }, true)).toBe(false);
    expect(allowVectaraFor({ vectaraOptIn: true, vectaraMultiTenantAck: true }, true)).toBe(true);
  });
});

function scored(score: number, scorer: GroundednessResult['scorer'] = 'hhem_2_1_open'): GroundednessResult {
  return { status: 'scored', scorer, score, reason: null, truncated: false, latency_ms: 120 };
}

describe('labelGroundedness', () => {
  it('labels scores against the default 0.5 cell', () => {
    expect(labelGroundedness(scored(0.62), 'en')).toMatchObject({
      label: 'verified',
      threshold: 0.5,
      thresholdSource: 'default',
      score: 0.62,
      scorer: 'hhem_2_1_open',
    });
    expect(labelGroundedness(scored(0.41), 'en')).toMatchObject({
      label: 'possibly_unreliable',
      threshold: 0.5,
      thresholdSource: 'default',
    });
    expect(labelGroundedness(scored(0.5), 'en').label).toBe('verified');
  });

  it('uses a calibrated cell for its (scorer, language)', () => {
    const { cells } = loadGroundednessThresholdsFromData({
      schema_version: 1,
      cells: [{ scorer: 'hhem_2_1_open', language: 'en', source: 'calibrated', threshold: 0.7 }],
    });
    expect(labelGroundedness(scored(0.62), 'en', cells)).toMatchObject({
      label: 'possibly_unreliable',
      threshold: 0.7,
      thresholdSource: 'calibrated',
    });
    expect(labelGroundedness(scored(0.62, 'hhem_2_3_vectara'), 'en', cells)).toMatchObject({
      label: 'verified',
      threshold: 0.5,
      thresholdSource: 'default',
    });
  });

  it('falls back to 0.5 default for a cell missing from the file', () => {
    expect(labelGroundedness(scored(0.55, 'hhem_2_3_vectara'), 'it')).toMatchObject({
      label: 'verified',
      threshold: 0.5,
      thresholdSource: 'default',
    });
  });

  it('gives not_checked without a score', () => {
    const result: GroundednessResult = {
      status: 'not_checked',
      scorer: 'none',
      score: null,
      reason: 'unsupported_language',
      truncated: false,
      latency_ms: 3,
    };
    expect(labelGroundedness(result, 'it')).toEqual({
      status: 'not_checked',
      label: 'not_checked',
      scorer: 'none',
      score: null,
      threshold: null,
      thresholdSource: null,
      reason: 'unsupported_language',
      truncated: false,
      latencyMs: 3,
    });
    expect(labelGroundedness({ ...scored(0.9), score: null }, 'en').label).toBe('not_checked');
  });

  it('loads the committed file with every cell at the 0.5 default', () => {
    const { cells } = loadGroundednessThresholds();
    expect(cells.get('hhem_2_3_vectara:en')).toEqual({ threshold: 0.5, source: 'default' });
    expect(cells.get('hhem_2_3_vectara:zh-Hans')).toEqual({ threshold: 0.5, source: 'default' });
    expect(cells.get('hhem_2_1_open:en')).toEqual({ threshold: 0.5, source: 'default' });
  });

  it('turns an invalid thresholds file into default cells with exactly one warning', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = await import('@/lib/rag/generation/groundedness');
    const first = fresh.loadGroundednessThresholdsFromData({ schema_version: 2, cells: 'nope' });
    fresh.loadGroundednessThresholdsFromData({ cells: [{ threshold: 7 }] });
    expect(first.cells.size).toBe(0);
    expect(fresh.labelGroundedness(scored(0.62), 'en', first.cells)).toMatchObject({
      label: 'verified',
      threshold: 0.5,
      thresholdSource: 'default',
    });
    const groundednessWarnings = warn.mock.calls.filter((call) => String(call[0]).startsWith('[Groundedness]'));
    expect(groundednessWarnings).toHaveLength(1);
  });
});
