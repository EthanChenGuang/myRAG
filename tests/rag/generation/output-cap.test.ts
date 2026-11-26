import { afterEach, describe, expect, it, vi } from 'vitest';
import committedCaps from '../../../eval/config/output-caps.json';
import { readAnswerConfig } from '@/lib/rag/generation/answer-config';
import {
  answerReserveTokens,
  decideOutputCap,
  effectiveMaxOutputTokens,
  outputCapFloor,
  resetOutputCapWarningsForTests,
  resolveOutputCap,
  type OutputCapContext,
} from '@/lib/rag/generation/output-cap';
import { getLanguageRegistry, packText, TEXT_KEYS } from '@/lib/rag/lang/registry';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { OutputCapsSchema } from '@/lib/rag-eval/contracts.generated';

const OFF = readAnswerConfig({});
const AUTO = readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: 'auto' });
const FIXED_700 = readAnswerConfig({ RAG_MAX_OUTPUT_TOKENS: '700' });

function caps(strict: number | null, balanced: number | null) {
  const cell = (mode: 'strict' | 'balanced', limit: number | null) =>
    limit === null
      ? { mode, limit: null, source: 'default', run_ids: [], config_hash: null }
      : { mode, limit, source: 'sweep', run_ids: ['run-test-1'], config_hash: 'hash-test-1' };
  return { schema_version: 1, cells: [cell('strict', strict), cell('balanced', balanced)] };
}

function context(overrides: Partial<OutputCapContext> = {}): OutputCapContext {
  return {
    config: FIXED_700,
    mode: 'strict',
    knowledgeContext: true,
    userMaxTokens: false,
    reasoning: false,
    approvalContinuation: false,
    channel: 'web',
    ...overrides,
  };
}

afterEach(() => {
  resetOutputCapWarningsForTests();
  vi.restoreAllMocks();
});

describe('the committed caps file (D-34)', () => {
  it('holds one off cell per mode with source default and validates against OutputCaps', () => {
    const parsed = OutputCapsSchema.parse(committedCaps);
    expect(parsed.cells.map((cell) => cell.mode).sort()).toEqual(['balanced', 'strict']);
    for (const cell of parsed.cells) {
      expect(cell.limit).toBeNull();
      expect(cell.source).toBe('default');
      expect(cell.config_hash).toBeNull();
      expect(cell.run_ids ?? []).toEqual([]);
    }
  });
});

describe('resolveOutputCap (D-29)', () => {
  it('off resolves to null for every mode', () => {
    for (const mode of ['strict', 'balanced', 'flexible', 'bypass']) expect(resolveOutputCap({ config: OFF, mode })).toBeNull();
  });

  it('auto with the committed file resolves to null for both modes', () => {
    expect(resolveOutputCap({ config: AUTO, mode: 'strict' })).toBeNull();
    expect(resolveOutputCap({ config: AUTO, mode: 'balanced' })).toBeNull();
  });

  it('auto with a file holding strict 900 gives 900 for strict and null for balanced', () => {
    expect(resolveOutputCap({ config: AUTO, mode: 'strict', caps: caps(900, null) })).toBe(900);
    expect(resolveOutputCap({ config: AUTO, mode: 'balanced', caps: caps(900, null) })).toBeNull();
  });

  it('an integer applies to strict and balanced only', () => {
    expect(resolveOutputCap({ config: FIXED_700, mode: 'strict' })).toBe(700);
    expect(resolveOutputCap({ config: FIXED_700, mode: 'balanced' })).toBe(700);
    expect(resolveOutputCap({ config: FIXED_700, mode: 'flexible' })).toBeNull();
    expect(resolveOutputCap({ config: FIXED_700, mode: 'bypass' })).toBeNull();
  });

  it('an invalid caps file is refused, never read as a cap', () => {
    expect(() => resolveOutputCap({ config: AUTO, mode: 'strict', caps: { schema_version: 1, cells: [] } })).toThrow();
  });
});

describe('effectiveMaxOutputTokens (D-29)', () => {
  it('is min(limit, cap) and never raises a limit', () => {
    expect(effectiveMaxOutputTokens(4096, 700)).toBe(700);
    expect(effectiveMaxOutputTokens(500, 700)).toBe(500);
    expect(effectiveMaxOutputTokens(4096, null)).toBe(4096);
  });
});

describe('outputCapFloor (D-31)', () => {
  it('is at least 256 and at least twice the longest registry notice in any language', () => {
    let longest = 0;
    for (const pack of getLanguageRegistry().packs) {
      for (const key of TEXT_KEYS) {
        if (!key.startsWith('notices.')) continue;
        const text = packText(pack, key);
        if (text) longest = Math.max(longest, countTokens(text));
      }
    }
    expect(longest).toBeGreaterThan(0);
    expect(outputCapFloor()).toBeGreaterThanOrEqual(256);
    expect(outputCapFloor()).toBeGreaterThanOrEqual(2 * longest);
    expect(outputCapFloor()).toBe(Math.max(256, 2 * longest));
  });
});

describe('decideOutputCap (D-30, D-31, D-32)', () => {
  it('applies to a strict or balanced turn with knowledge context', () => {
    expect(decideOutputCap(context())).toEqual({ applied: true, cap: 700, concise: true, reason: 'applied' });
    expect(decideOutputCap(context({ mode: 'balanced' }))).toEqual({ applied: true, cap: 700, concise: true, reason: 'applied' });
  });

  it('off: nothing applies and no concise part', () => {
    expect(decideOutputCap(context({ config: OFF }))).toEqual({ applied: false, cap: null, concise: false, reason: 'off' });
  });

  it.each([
    ['user_max_tokens', { userMaxTokens: true }],
    ['reasoning', { reasoning: true }],
    ['mode', { mode: 'flexible' }],
    ['mode', { mode: 'bypass' }],
    ['no_context', { knowledgeContext: false }],
    ['approval_continuation', { approvalContinuation: true }],
    ['voice', { channel: 'voice' }],
  ] as const)('is not applied with reason %s', (reason, overrides) => {
    const decision = decideOutputCap(context(overrides as Partial<OutputCapContext>));
    expect(decision).toMatchObject({ applied: false, concise: false, reason });
  });

  it('WhatsApp keeps its own limit and gets only the concise instruction', () => {
    expect(decideOutputCap(context({ channel: 'whatsapp' }))).toMatchObject({ applied: false, concise: true, reason: 'user_max_tokens' });
    expect(decideOutputCap(context({ channel: 'whatsapp', userMaxTokens: true }))).toMatchObject({ applied: false, concise: true });
    expect(decideOutputCap(context({ channel: 'whatsapp', reasoning: true }))).toMatchObject({ applied: false, concise: false });
    expect(decideOutputCap(context({ channel: 'whatsapp', config: OFF }))).toMatchObject({ applied: false, concise: false });
  });

  it('auto with an off cell is not applied (reason no_cap)', () => {
    expect(decideOutputCap(context({ config: AUTO }))).toMatchObject({ applied: false, cap: null, concise: false, reason: 'no_cap' });
    expect(decideOutputCap(context({ config: AUTO, caps: caps(900, null) }))).toMatchObject({ applied: true, cap: 900 });
  });

  it('a cap below the floor is not applied and logs one warning code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const low = outputCapFloor() - 1;
    const first = decideOutputCap(context({ config: AUTO, caps: caps(low, null) }));
    decideOutputCap(context({ config: AUTO, caps: caps(low, null) }));
    expect(first).toEqual({ applied: false, cap: null, concise: false, reason: 'below_floor' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('max_output_tokens_below_floor');
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(String(low));
  });

  it('a cap at the floor applies', () => {
    const floor = outputCapFloor();
    expect(decideOutputCap(context({ config: AUTO, caps: caps(floor, floor) }))).toMatchObject({ applied: true, cap: floor });
  });
});

describe('answerReserveTokens (D-31, D-80)', () => {
  it('is the effective cap when the cap applies, else the model limit', () => {
    expect(answerReserveTokens({ decision: decideOutputCap(context()), modelLimit: 4096 })).toBe(700);
    expect(answerReserveTokens({ decision: decideOutputCap(context()), modelLimit: 500 })).toBe(500);
    expect(answerReserveTokens({ decision: decideOutputCap(context({ config: OFF })), modelLimit: 4096 })).toBe(4096);
    expect(answerReserveTokens({ decision: decideOutputCap(context({ channel: 'whatsapp' })), modelLimit: 4096 })).toBe(4096);
  });
});
