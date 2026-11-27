import { afterEach, describe, expect, it } from 'vitest';
import { countContextTokens } from '@/lib/rag/context/budget';
import {
  estimateTokens,
  factorFor,
  parsePromptBudgetConfig,
  parseTokenizerCalibration,
  promptBudgetConfig,
  promptBudgetConfigVersion,
  tokenizerCalibration,
  tokenizerCalibrationVersion,
} from '@/lib/rag/context/prompt-budget-config';
import { modelContextLength, modelFamily, setModelContextLengthOverrides } from '@/lib/rag/context/model-window';
import rawBudget from '../../../config/rag/prompt-budget.json';
import rawCalibration from '../../../eval/config/tokenizer-calibration.json';

const NO_ENV: Record<string, string | undefined> = {};

afterEach(() => {
  setModelContextLengthOverrides(null);
});

describe('modelContextLength', () => {
  it('returns the configured window of a listed OpenRouter model', () => {
    expect(modelContextLength('anthropic/claude-sonnet-5.5', NO_ENV)).toBe(1000000);
    expect(modelContextLength('openai/gpt-4.1', NO_ENV)).toBe(1047576);
  });

  it('reads the OpenAI and Groq lists too', () => {
    expect(modelContextLength('o3', NO_ENV)).toBe(200000);
    expect(modelContextLength('llama3-8b-8192', NO_ENV)).toBe(8192);
  });

  it('returns null for an unlisted id and for a listed model without a window', () => {
    expect(modelContextLength('vendor/not-a-listed-model', NO_ENV)).toBeNull();
    expect(modelContextLength('cognitivecomputations/dolphin-mistral-24b-venice-edition:free', NO_ENV)).toBeNull();
  });

  it('reads a configured list from the environment and ignores a non-positive or non-integer window', () => {
    const source = {
      NEXT_PUBLIC_OPENROUTER_MODELS: JSON.stringify([
        { id: 'vendor/a', displayName: 'A', contextLength: 32000 },
        { id: 'vendor/b', displayName: 'B', contextLength: 0 },
        { id: 'vendor/c', displayName: 'C', contextLength: 1.5 },
      ]),
    };
    expect(modelContextLength('vendor/a', source)).toBe(32000);
    expect(modelContextLength('vendor/b', source)).toBeNull();
    expect(modelContextLength('vendor/c', source)).toBeNull();
  });

  it('returns null when a configured list is not valid JSON', () => {
    expect(modelContextLength('vendor/a', { NEXT_PUBLIC_OPENROUTER_MODELS: '[not json' })).toBeNull();
  });

  it('uses the eval override map for fake model ids, and only while it is set', () => {
    setModelContextLengthOverrides({ 'fixture/small-window-4k': 4096 });
    expect(modelContextLength('fixture/small-window-4k', NO_ENV)).toBe(4096);
    setModelContextLengthOverrides(null);
    expect(modelContextLength('fixture/small-window-4k', NO_ENV)).toBeNull();
  });
});

describe('modelFamily', () => {
  it('is the provider prefix before the first slash', () => {
    expect(modelFamily('openai/gpt-4.1')).toBe('openai');
    expect(modelFamily('anthropic/claude-sonnet-5.5')).toBe('anthropic');
    expect(modelFamily('meta-llama/llama-4-maverick')).toBe('meta-llama');
  });

  it('maps fake ids to fixture', () => {
    expect(modelFamily('fixture/small-window-4k')).toBe('fixture');
    setModelContextLengthOverrides({ 'small-window-fake': 2048 });
    expect(modelFamily('small-window-fake')).toBe('fixture');
  });

  it('is null for an id without a provider prefix or with an invalid one', () => {
    expect(modelFamily('gpt-4.1')).toBeNull();
    expect(modelFamily('/x')).toBeNull();
    expect(modelFamily('Bad Prefix/x')).toBeNull();
  });
});

describe('prompt-budget data files', () => {
  it('the committed files validate and carry the starting values', () => {
    expect(promptBudgetConfig()).toMatchObject({
      version: 1,
      default_window: 16384,
      margin_ratio: 0.05,
      margin_tokens: 256,
      near_limit_ratio: 0.9,
      mcp_tool_reserve: 2000,
      voice_document_budget: 2000,
      refine_max_calls: 4,
    });
    expect(tokenizerCalibration()).toMatchObject({ version: 1, encoding: 'cl100k_base', default_factor: 1.25, written_by: 'default' });
    expect(tokenizerCalibration().families ?? []).toEqual([]);
  });

  it('an invalid prompt-budget file throws', () => {
    expect(() => parsePromptBudgetConfig({ ...rawBudget, margin_ratio: 0.9 })).toThrow(/prompt-budget\.json/);
    expect(() => parsePromptBudgetConfig({ ...rawBudget, unknown_key: 1 })).toThrow(/prompt-budget\.json/);
    expect(() => parsePromptBudgetConfig({ ...rawBudget, default_window: 100 })).toThrow(/prompt-budget\.json/);
  });

  it('an invalid calibration file throws, including the model-level rules', () => {
    expect(() => parseTokenizerCalibration({ ...rawCalibration, default_factor: 0.8 })).toThrow(/tokenizer-calibration\.json/);
    const cell = { family: 'openai', factor: 1.1, quantile: 0.95, samples: 10, source: 'measured', run_ids: ['run-1'] };
    expect(() => parseTokenizerCalibration({ ...rawCalibration, families: [cell, cell] })).toThrow(/at most once/);
    expect(() =>
      parseTokenizerCalibration({ ...rawCalibration, families: [{ ...cell, samples: 0 }] }),
    ).toThrow(/samples and run_ids/);
    expect(() =>
      parseTokenizerCalibration({ ...rawCalibration, families: [{ ...cell, run_ids: [] }] }),
    ).toThrow(/samples and run_ids/);
    expect(parseTokenizerCalibration({ ...rawCalibration, families: [cell] }).families).toHaveLength(1);
  });

  it('file versions are sha256 hex digests that follow the content', () => {
    expect(promptBudgetConfigVersion()).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenizerCalibrationVersion()).toMatch(/^[0-9a-f]{64}$/);
    expect(promptBudgetConfigVersion()).not.toBe(tokenizerCalibrationVersion());
  });
});

describe('estimateTokens and factorFor', () => {
  const calibration = parseTokenizerCalibration({
    ...rawCalibration,
    default_factor: 1.25,
    families: [{ family: 'fixture', factor: 1.5, quantile: 0.95, samples: 3, source: 'measured', run_ids: ['r1'] }],
  });
  const text = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa.';

  it('a recorded family uses its factor and source', () => {
    expect(factorFor('fixture', calibration)).toEqual({ factor: 1.5, source: 'measured' });
    expect(estimateTokens(text, 'fixture', calibration)).toBe(Math.ceil(countContextTokens(text) * 1.5));
  });

  it('a family without a record, or no family, uses the default factor with source default', () => {
    expect(factorFor('openai', calibration)).toEqual({ factor: 1.25, source: 'default' });
    expect(factorFor(null, calibration)).toEqual({ factor: 1.25, source: 'default' });
    expect(estimateTokens(text, 'openai', calibration)).toBe(Math.ceil(countContextTokens(text) * 1.25));
  });

  it('reads the committed calibration when none is given, and an empty text is zero', () => {
    expect(estimateTokens(text, 'anthropic')).toBe(Math.ceil(countContextTokens(text) * 1.25));
    expect(estimateTokens('', 'anthropic')).toBe(0);
  });
});
