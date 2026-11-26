import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_OUTPUT_TOKENS_FLOOR,
  readAnswerConfig,
  resetAnswerConfigWarningsForTests,
  warnAnswerConfigOnce,
} from '@/lib/rag/generation/answer-config';

const BOOLEAN_SWITCHES = [
  ['RAG_REGISTRY_TEXTS', 'registryTexts'],
  ['RAG_PARTIAL_ANSWER_RULE', 'partialAnswerRule'],
  ['RAG_CONTEXT_RELEVANCE_RULE', 'contextRelevanceRule'],
  ['RAG_VERSION_LABELS', 'versionLabels'],
  ['RAG_SECURITY_EVENTS', 'securityEvents'],
] as const;

describe('readAnswerConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAnswerConfigWarningsForTests();
  });

  it('returns every switch at its D-58 default with an empty environment', () => {
    const config = readAnswerConfig({});
    expect(config).toEqual({
      registryTexts: false,
      partialAnswerRule: false,
      contextRelevanceRule: false,
      citationPerSentence: false,
      claimCheck: false,
      llmJudge: false,
      judgeModel: '',
      maxOutputTokens: { kind: 'off' },
      outputGuard: 'off',
      versionLabels: false,
      securityEvents: false,
      uploaderAlertThreshold: 0,
      uploaderAlertWindowHours: 24,
      uploaderHold: 'off',
      anyNonDefault: false,
      warnings: [],
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.maxOutputTokens)).toBe(true);
    expect(Object.isFrozen(config.warnings)).toBe(true);
  });

  it('returns the same defaults for the committed template values', () => {
    const config = readAnswerConfig({
      RAG_REGISTRY_TEXTS: 'false',
      RAG_PARTIAL_ANSWER_RULE: 'false',
      RAG_CONTEXT_RELEVANCE_RULE: 'false',
      RAG_CITATION_PER_SENTENCE: 'false',
      RAG_CLAIM_CHECK: 'false',
      RAG_GROUNDEDNESS_LLM_JUDGE: 'false',
      RAG_GROUNDEDNESS_JUDGE_MODEL: '',
      RAG_MAX_OUTPUT_TOKENS: 'off',
      RAG_OUTPUT_GUARD: 'off',
      RAG_VERSION_LABELS: 'false',
      RAG_SECURITY_EVENTS: 'false',
      RAG_UPLOADER_ALERT_THRESHOLD: '0',
      RAG_UPLOADER_ALERT_WINDOW_HOURS: '24',
      RAG_UPLOADER_HOLD: 'off',
    });
    expect(config.anyNonDefault).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  it.each(BOOLEAN_SWITCHES)('turns %s on only for the literal true', (name, key) => {
    expect(readAnswerConfig({ [name]: 'true' })[key]).toBe(true);
    expect(readAnswerConfig({ [name]: ' true ' })[key]).toBe(true);
    expect(readAnswerConfig({ [name]: 'TRUE' })[key]).toBe(false);
    expect(readAnswerConfig({ [name]: '1' })[key]).toBe(false);
    expect(readAnswerConfig({ [name]: 'true' }).anyNonDefault).toBe(true);
  });

  it('parses the output cap as off, auto or a fixed integer', () => {
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: 'auto' }).maxOutputTokens).toEqual({ kind: 'auto' });
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: '600' }).maxOutputTokens).toEqual({ kind: 'fixed', value: 600 });
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: ' 600 ' }).maxOutputTokens).toEqual({ kind: 'fixed', value: 600 });
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: 'off' }).maxOutputTokens).toEqual({ kind: 'off' });
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: 'auto' }).anyNonDefault).toBe(true);
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: '600' }).warnings).toEqual([]);
  });

  it.each(['0', '-5', '1.5', 'abc', 'AUTO', '1e3', '0x400'])('falls back to off for the cap %s', (raw) => {
    const config = readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: raw });
    expect(config.maxOutputTokens).toEqual({ kind: 'off' });
    expect(config.warnings.map((warning) => warning.code)).toEqual(['max_output_tokens_invalid']);
    expect(config.anyNonDefault).toBe(false);
  });

  it('rejects a fixed cap below the floor', () => {
    expect(MIN_OUTPUT_TOKENS_FLOOR).toBe(256);
    const below = readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: '255' });
    expect(below.maxOutputTokens).toEqual({ kind: 'off' });
    expect(below.warnings.map((warning) => warning.code)).toEqual(['max_output_tokens_below_floor']);
    expect(readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: '256' }).maxOutputTokens).toEqual({ kind: 'fixed', value: 256 });
  });

  it('parses the output guard modes and falls back to off for any other value', () => {
    expect(readAnswerConfig({ RAG_OUTPUT_GUARD: 'flag' }).outputGuard).toBe('flag');
    expect(readAnswerConfig({ RAG_OUTPUT_GUARD: 'enforce' }).outputGuard).toBe('enforce');
    expect(readAnswerConfig({ RAG_OUTPUT_GUARD: 'enforce' }).anyNonDefault).toBe(true);
    const invalid = readAnswerConfig({ RAG_OUTPUT_GUARD: 'block' });
    expect(invalid.outputGuard).toBe('off');
    expect(invalid.warnings.map((warning) => warning.code)).toEqual(['invalid_output_guard']);
  });

  it('parses the uploader hold modes and falls back to off for any other value', () => {
    expect(readAnswerConfig({ RAG_UPLOADER_HOLD: 'manual' }).uploaderHold).toBe('manual');
    expect(readAnswerConfig({ RAG_UPLOADER_HOLD: 'auto' }).uploaderHold).toBe('auto');
    const invalid = readAnswerConfig({ RAG_UPLOADER_HOLD: 'always' });
    expect(invalid.uploaderHold).toBe('off');
    expect(invalid.warnings.map((warning) => warning.code)).toEqual(['invalid_uploader_hold']);
  });

  it('turns per-sentence citations off without inline or Claude citations', () => {
    const alone = readAnswerConfig({ RAG_CITATION_PER_SENTENCE: 'true' });
    expect(alone.citationPerSentence).toBe(false);
    expect(alone.anyNonDefault).toBe(false);
    expect(alone.warnings.map((warning) => warning.code)).toEqual(['per_sentence_needs_citations']);
    expect(readAnswerConfig({ RAG_CITATION_PER_SENTENCE: 'true', RAG_CITATIONS: 'true' }).citationPerSentence).toBe(true);
    const claude = readAnswerConfig({ RAG_CITATION_PER_SENTENCE: 'true', RAG_CLAUDE_CITATIONS: 'true' });
    expect(claude.citationPerSentence).toBe(true);
    expect(claude.warnings).toEqual([]);
  });

  it('turns the judge off without a model', () => {
    const noModel = readAnswerConfig({ RAG_GROUNDEDNESS_LLM_JUDGE: 'true', RAG_GROUNDEDNESS_JUDGE_MODEL: '   ' });
    expect(noModel.llmJudge).toBe(false);
    expect(noModel.warnings.map((warning) => warning.code)).toEqual(['judge_needs_model']);
    const withModel = readAnswerConfig({
      RAG_GROUNDEDNESS_LLM_JUDGE: 'true',
      RAG_GROUNDEDNESS_JUDGE_MODEL: ' provider/judge-model ',
    });
    expect(withModel.llmJudge).toBe(true);
    expect(withModel.judgeModel).toBe('provider/judge-model');
    expect(withModel.warnings).toEqual([]);
  });

  it('keeps a judge model alone as a non-behavioural setting', () => {
    const config = readAnswerConfig({ RAG_GROUNDEDNESS_JUDGE_MODEL: 'provider/judge-model' });
    expect(config.llmJudge).toBe(false);
    expect(config.anyNonDefault).toBe(false);
  });

  it('turns the claim check off without groundedness scoring', () => {
    const alone = readAnswerConfig({ RAG_CLAIM_CHECK: 'true' });
    expect(alone.claimCheck).toBe(false);
    expect(alone.warnings.map((warning) => warning.code)).toEqual(['claim_check_needs_groundedness']);
    const on = readAnswerConfig({ RAG_CLAIM_CHECK: 'true', RAG_GROUNDEDNESS: 'true' });
    expect(on.claimCheck).toBe(true);
    expect(on.anyNonDefault).toBe(true);
  });

  it('clamps the alert window to 1..720 hours', () => {
    expect(readAnswerConfig({ RAG_UPLOADER_ALERT_WINDOW_HOURS: '0' }).uploaderAlertWindowHours).toBe(1);
    expect(readAnswerConfig({ RAG_UPLOADER_ALERT_WINDOW_HOURS: '5000' }).uploaderAlertWindowHours).toBe(720);
    expect(readAnswerConfig({ RAG_UPLOADER_ALERT_WINDOW_HOURS: '48' }).uploaderAlertWindowHours).toBe(48);
    const invalid = readAnswerConfig({ RAG_UPLOADER_ALERT_WINDOW_HOURS: 'two days' });
    expect(invalid.uploaderAlertWindowHours).toBe(24);
    expect(invalid.warnings.map((warning) => warning.code)).toEqual(['invalid_uploader_alert_window_hours']);
  });

  it.each(['1.5', '-1', 'many'])('falls back to a threshold of 0 for %s', (raw) => {
    const config = readAnswerConfig({ RAG_UPLOADER_ALERT_THRESHOLD: raw });
    expect(config.uploaderAlertThreshold).toBe(0);
    expect(config.warnings.map((warning) => warning.code)).toEqual(['invalid_uploader_alert_threshold']);
  });

  it('accepts a positive alert threshold', () => {
    const config = readAnswerConfig({ RAG_UPLOADER_ALERT_THRESHOLD: '3' });
    expect(config.uploaderAlertThreshold).toBe(3);
    expect(config.anyNonDefault).toBe(true);
  });

  it('never repeats a configured value in a warning message', () => {
    const marker = 'zq-sentinel-7731';
    const config = readAnswerConfig({
      RAG_MAX_OUTPUT_TOKENS: marker,
      RAG_OUTPUT_GUARD: marker,
      RAG_UPLOADER_HOLD: marker,
      RAG_UPLOADER_ALERT_THRESHOLD: marker,
      RAG_UPLOADER_ALERT_WINDOW_HOURS: marker,
      RAG_CITATION_PER_SENTENCE: 'true',
      RAG_CLAIM_CHECK: 'true',
      RAG_GROUNDEDNESS_LLM_JUDGE: 'true',
    });
    expect(config.warnings).toHaveLength(8);
    for (const warning of config.warnings) {
      expect(warning.message).not.toContain(marker);
      expect(warning.message).toMatch(/RAG_[A-Z_]+/);
    }
    const below = readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: '137' });
    expect(below.warnings[0].message).not.toContain('137');
  });

  it('reads process.env at call time', () => {
    vi.stubEnv('RAG_OUTPUT_GUARD', 'flag');
    expect(readAnswerConfig().outputGuard).toBe('flag');
    vi.stubEnv('RAG_OUTPUT_GUARD', 'off');
    expect(readAnswerConfig().outputGuard).toBe('off');
    vi.unstubAllEnvs();
  });
});

describe('warnAnswerConfigOnce', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAnswerConfigWarningsForTests();
  });

  it('logs nothing with every switch at its default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnAnswerConfigOnce(readAnswerConfig({}));
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs one [Answer Rules] line with codes only, once per code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = { RAG_OUTPUT_GUARD: 'zq-sentinel', RAG_CLAIM_CHECK: 'true' };
    warnAnswerConfigOnce(readAnswerConfig(source));
    warnAnswerConfigOnce(readAnswerConfig(source));
    expect(warn).toHaveBeenCalledTimes(1);
    const [line, detail] = warn.mock.calls[0];
    expect(String(line)).toMatch(/^\[Answer Rules\]/);
    expect(detail).toEqual({ codes: ['invalid_output_guard', 'claim_check_needs_groundedness'] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('zq-sentinel');
    warnAnswerConfigOnce(readAnswerConfig({ RAG_UPLOADER_HOLD: 'x' }));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][1]).toEqual({ codes: ['invalid_uploader_hold'] });
  });
});
