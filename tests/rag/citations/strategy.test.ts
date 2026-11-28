import { describe, expect, it } from 'vitest';
import {
  CLAUDE_WEB_SEARCH_ELIGIBLE,
  claudeTurnEligibility,
  preRetrievalCitations,
  selectCitationStrategy,
  type ClaudeIneligibleReason,
  type ClaudeTurnEligibilityInput,
} from '@/lib/rag/generation/citations/strategy';

const MODELS = JSON.stringify([
  { id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5' },
  { id: 'anthropic/claude-opus-4.5', displayName: 'Claude Opus 4.5', anthropicId: 'claude-opus-4-5' },
  { id: 'anthropic/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5' },
  { id: 'meta-llama/llama-3.3-70b-instruct', displayName: 'Llama' },
]);
const SOURCE = { NEXT_PUBLIC_OPENROUTER_MODELS: MODELS };
const CLAUDE = 'anthropic/claude-sonnet-5.5';

function eligibleInput(): ClaudeTurnEligibilityInput {
  return {
    modelId: CLAUDE,
    capabilities: { citations: true },
    ragMode: 'strict',
    aliasCount: 2,
    facts: { mcp: false, multiStep: false, webSearch: false, reasoning: false },
    config: { citations: false, claudeCitations: true, anthropicApiKey: 'test-anthropic-key-placeholder' },
    modelSource: SOURCE,
  };
}

const FAILURES: Array<[ClaudeIneligibleReason, (input: ClaudeTurnEligibilityInput) => ClaudeTurnEligibilityInput]> = [
  ['switch_off', (i) => ({ ...i, config: { ...i.config, claudeCitations: false } })],
  ['no_api_key', (i) => ({ ...i, config: { ...i.config, anthropicApiKey: null } })],
  ['no_anthropic_id', (i) => ({ ...i, modelId: 'anthropic/claude-sonnet-4.5' })],
  ['no_capability', (i) => ({ ...i, capabilities: null })],
  ['no_knowledge_context', (i) => ({ ...i, aliasCount: 0 })],
  ['mcp', (i) => ({ ...i, facts: { ...i.facts, mcp: true } })],
  ['multi_step', (i) => ({ ...i, facts: { ...i.facts, multiStep: true } })],
  ['web_search', (i) => ({ ...i, facts: { ...i.facts, webSearch: true } })],
  ['attachments', (i) => ({ ...i, facts: { ...i.facts, attachments: true } })],
  ['reasoning_unsupported', (i) => ({ ...i, modelId: 'anthropic/claude-opus-4.5', facts: { ...i.facts, reasoning: true } })],
];

describe('claudeTurnEligibility (D-10)', () => {
  it('is eligible with the Anthropic id when every condition holds', () => {
    expect(claudeTurnEligibility(eligibleInput())).toEqual({ eligible: true, anthropicId: 'claude-sonnet-5-5' });
  });

  it.each(FAILURES)('returns %s when only that condition fails', (reason, change) => {
    expect(claudeTurnEligibility(change(eligibleInput()))).toEqual({ eligible: false, reason });
  });

  it('keeps reasoning turns eligible on an adaptive-thinking model', () => {
    const input = eligibleInput();
    expect(claudeTurnEligibility({ ...input, facts: { ...input.facts, reasoning: true } })).toEqual({
      eligible: true,
      anthropicId: 'claude-sonnet-5-5',
    });
  });

  it('treats a missing switch value, a missing capability flag and bypass mode as ineligible', () => {
    const input = eligibleInput();
    expect(claudeTurnEligibility({ ...input, config: { citations: true } })).toEqual({ eligible: false, reason: 'switch_off' });
    expect(claudeTurnEligibility({ ...input, capabilities: { citations: false } })).toEqual({ eligible: false, reason: 'no_capability' });
    expect(claudeTurnEligibility({ ...input, ragMode: 'bypass' })).toEqual({ eligible: false, reason: 'no_knowledge_context' });
  });

  it('holds webSearch turns ineligible until plan 05-26', () => {
    expect(CLAUDE_WEB_SEARCH_ELIGIBLE).toBe(false);
  });
});

describe('selectCitationStrategy (D-01)', () => {
  const turn = (overrides: Partial<ClaudeTurnEligibilityInput> = {}) => {
    const input = { ...eligibleInput(), ...overrides };
    return {
      modelId: input.modelId,
      modelSource: SOURCE,
      config: input.config,
      turn: {
        capabilities: input.capabilities ?? { citations: false },
        ragMode: input.ragMode,
        aliasCount: input.aliasCount,
        facts: input.facts,
      },
    };
  };

  it('picks claude-citations when the turn is eligible, whatever RAG_CITATIONS says', () => {
    expect(selectCitationStrategy(turn())).toBe('claude-citations');
    expect(selectCitationStrategy(turn({ config: { ...eligibleInput().config, citations: true } }))).toBe('claude-citations');
  });

  it.each(FAILURES.filter(([reason]) => reason !== 'no_capability' && reason !== 'no_knowledge_context'))(
    'an ineligible turn (%s) falls to chunk-alias with RAG_CITATIONS on and to none with it off',
    (_reason, change) => {
      const changed = change(eligibleInput());
      expect(selectCitationStrategy(turn({ ...changed, config: { ...changed.config, citations: true } }))).toBe('chunk-alias');
      expect(selectCitationStrategy(turn({ ...changed, config: { ...changed.config, citations: false } }))).toBeNull();
    },
  );

  it('returns none without blocks, without the capability, or in bypass mode', () => {
    const on = { ...eligibleInput().config, citations: true };
    expect(selectCitationStrategy(turn({ aliasCount: 0, config: on }))).toBeNull();
    expect(selectCitationStrategy(turn({ capabilities: { citations: false }, config: on }))).toBeNull();
    expect(selectCitationStrategy(turn({ ragMode: 'bypass', config: on }))).toBeNull();
  });

  it('never picks claude-citations when the turn facts are absent', () => {
    const input = turn();
    const { facts: _facts, ...withoutFacts } = input.turn;
    expect(selectCitationStrategy({ ...input, turn: withoutFacts })).toBeNull();
    expect(selectCitationStrategy({ ...input, turn: withoutFacts, config: { ...input.config, citations: true } })).toBe('chunk-alias');
  });
});

describe('preRetrievalCitations', () => {
  const base = eligibleInput();

  it('is true with RAG_CITATIONS on and the capability', () => {
    expect(
      preRetrievalCitations({ config: { citations: true }, modelId: 'meta-llama/llama-3.3-70b-instruct', capabilities: { citations: true }, modelSource: SOURCE }),
    ).toBe(true);
  });

  it('is true when the Claude conditions known before retrieval hold, with RAG_CITATIONS off', () => {
    expect(preRetrievalCitations({ config: base.config, modelId: CLAUDE, capabilities: { citations: true }, modelSource: SOURCE })).toBe(true);
    expect(
      preRetrievalCitations({ config: base.config, modelId: CLAUDE, capabilities: { citations: true }, facts: base.facts, ragMode: 'strict', modelSource: SOURCE }),
    ).toBe(true);
  });

  it('is false when no strategy could use the labels', () => {
    const off = { citations: false, claudeCitations: false, anthropicApiKey: 'k' };
    expect(preRetrievalCitations({ config: off, modelId: CLAUDE, capabilities: { citations: true }, modelSource: SOURCE })).toBe(false);
    expect(preRetrievalCitations({ config: base.config, modelId: CLAUDE, capabilities: null, modelSource: SOURCE })).toBe(false);
    expect(
      preRetrievalCitations({ config: { ...base.config, anthropicApiKey: null }, modelId: CLAUDE, capabilities: { citations: true }, modelSource: SOURCE }),
    ).toBe(false);
    expect(
      preRetrievalCitations({ config: base.config, modelId: 'anthropic/claude-sonnet-4.5', capabilities: { citations: true }, modelSource: SOURCE }),
    ).toBe(false);
    expect(
      preRetrievalCitations({
        config: base.config,
        modelId: CLAUDE,
        capabilities: { citations: true },
        facts: { ...base.facts, webSearch: true },
        modelSource: SOURCE,
      }),
    ).toBe(false);
    expect(
      preRetrievalCitations({ config: { ...base.config, citations: true }, modelId: CLAUDE, capabilities: { citations: true }, ragMode: 'bypass', modelSource: SOURCE }),
    ).toBe(false);
  });
});
