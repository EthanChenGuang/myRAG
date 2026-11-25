import { describe, expect, test } from 'vitest';
import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryLayerConfig } from '@/lib/rag/config';
import type { GateResult, Transform } from '@/lib/rag/query/rewrite-gate';
import { routeTransforms } from '@/lib/rag/query/router';

function layer(overrides: Partial<QueryLayerConfig> = {}, transforms: Partial<QueryLayerConfig['transforms']> = {}): QueryLayerConfig {
  return {
    enabled: true,
    framework: 'llamaindex',
    model: 'test-model',
    transforms: { condense: true, expand: true, decompose: true, translate: true, normalizeDates: true, hyde: false, ...transforms },
    translateDisabledProfiles: [],
    voiceTransforms: ['condense_history', 'normalize_dates'],
    ...overrides,
  };
}

function gate(transforms: Transform[], extra: Partial<GateResult> = {}): GateResult {
  return { rewrite: transforms.length > 0, transforms, reasons: [], lang: 'en', protectedTokens: [], ...extra };
}

function classified(category: QueryClassification['category'], needsMcp: boolean): QueryClassification {
  return { category, needsMcp, confidence: 0.9, reasoningText: 'test' };
}

const EMBEDDING_PROFILE = 'synthetic-profile-a';

describe('routeTransforms', () => {
  test('maps gate transforms to stage names with the default switches', () => {
    const routed = routeTransforms({ gate: gate(['condense_history', 'expand']), config: layer(), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(routed.transforms).toEqual(['condense', 'expand']);
    expect(routed.skipRetrieval).toBe(false);
    expect(routed.framework).toBe('llamaindex');
    expect(routed.skipped).toEqual([{ transform: 'hyde', reason: 'disabled', status: 'disabled' }]);
  });

  test('maps every gate transform (condense_history to condense, normalize_dates, decompose, expand, translate)', () => {
    const routed = routeTransforms({
      gate: gate(['condense_history', 'normalize_dates', 'decompose', 'expand', 'translate']),
      config: layer({}, { hyde: true }),
      profile: 'chat',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(routed.transforms).toEqual(['condense', 'normalize_dates', 'translate', 'expand', 'hyde', 'decompose']);
    expect(routed.skipped).toEqual([]);
  });

  test('adds hyde next to expand only when RAG_QUERY_HYDE is on', () => {
    const on = routeTransforms({ gate: gate(['condense_history', 'expand']), config: layer({}, { hyde: true }), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(on.transforms).toEqual(['condense', 'expand', 'hyde']);
    const noExpand = routeTransforms({ gate: gate(['condense_history']), config: layer({}, { hyde: true }), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(noExpand.transforms).toEqual(['condense']);
    expect(noExpand.skipped).toEqual([]);
  });

  test('a switched-off transform is recorded as disabled, never degraded', () => {
    const routed = routeTransforms({ gate: gate(['condense_history', 'expand']), config: layer({}, { expand: false }), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(routed.transforms).toEqual(['condense']);
    expect(routed.skipped).toContainEqual({ transform: 'expand', reason: 'disabled', status: 'disabled' });
    for (const entry of routed.skipped) expect(entry.status).toBe('disabled');
    const offSwitches = routeTransforms({
      gate: gate(['condense_history', 'normalize_dates', 'decompose', 'translate']),
      config: layer({}, { condense: false, normalizeDates: false, decompose: false, translate: false }),
      profile: 'chat',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(offSwitches.transforms).toEqual([]);
    expect(offSwitches.skipped.map((entry) => [entry.transform, entry.reason])).toEqual([
      ['condense', 'disabled'],
      ['normalize_dates', 'disabled'],
      ['translate', 'disabled'],
      ['decompose', 'disabled'],
    ]);
  });

  test('tool_required with needsMcp gives no transforms and skips every gate transform as classifier_tool', () => {
    const routed = routeTransforms({
      gate: gate(['condense_history', 'normalize_dates', 'expand']),
      classification: classified('tool_required', true),
      config: layer({}, { hyde: true }),
      profile: 'chat',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(routed.transforms).toEqual([]);
    expect(routed.skipped).toEqual([
      { transform: 'condense', reason: 'classifier_tool', status: 'disabled' },
      { transform: 'normalize_dates', reason: 'classifier_tool', status: 'disabled' },
      { transform: 'expand', reason: 'classifier_tool', status: 'disabled' },
      { transform: 'hyde', reason: 'classifier_tool', status: 'disabled' },
    ]);
  });

  test('tool_required without needsMcp is ignored', () => {
    const routed = routeTransforms({
      gate: gate(['condense_history', 'expand']),
      classification: classified('tool_required', false),
      config: layer(),
      profile: 'chat',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(routed.transforms).toEqual(['condense', 'expand']);
  });

  test('multi_step adds the decompose hint for chat even when the gate did not fire R3 or R6', () => {
    const routed = routeTransforms({
      gate: gate(['condense_history']),
      classification: classified('multi_step', false),
      config: layer(),
      profile: 'chat',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(routed.transforms).toEqual(['condense', 'decompose']);
    const withMcp = routeTransforms({ gate: gate([]), classification: classified('multi_step', true), config: layer(), profile: 'embed', embeddingProfileId: EMBEDDING_PROFILE });
    expect(withMcp.transforms).toEqual(['decompose']);
  });

  test('conversational, complex and document_search never remove or add a gate transform; no classification changes nothing', () => {
    const base = routeTransforms({ gate: gate(['condense_history', 'expand', 'decompose']), config: layer(), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    for (const [category, needsMcp] of [
      ['conversational', false],
      ['complex', true],
      ['complex', false],
      ['document_search', false],
    ] as const) {
      const routed = routeTransforms({
        gate: gate(['condense_history', 'expand', 'decompose']),
        classification: classified(category, needsMcp),
        config: layer(),
        profile: 'chat',
        embeddingProfileId: EMBEDDING_PROFILE,
      });
      expect(routed).toEqual(base);
    }
    expect(base.transforms).toEqual(['condense', 'expand', 'decompose']);
    const noDecompose = routeTransforms({ gate: gate(['expand']), classification: classified('complex', true), config: layer(), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(noDecompose.transforms).toEqual(['expand']);
  });

  test('voice runs only the allow-list intersected with condense, normalize_dates and translate', () => {
    const routed = routeTransforms({
      gate: gate(['condense_history', 'normalize_dates', 'expand', 'decompose']),
      config: layer({ framework: 'langchain' }, { hyde: true }),
      profile: 'voice',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(routed.transforms).toEqual(['condense', 'normalize_dates']);
    expect(routed.framework).toBe('llamaindex');
    expect(routed.skipped).toEqual([
      { transform: 'expand', reason: 'voice_blocked', status: 'disabled' },
      { transform: 'hyde', reason: 'voice_blocked', status: 'disabled' },
      { transform: 'decompose', reason: 'voice_blocked', status: 'disabled' },
    ]);
  });

  test('hyde, expand and decompose never run for voice even if the allow-list names them', () => {
    const forced = layer({ voiceTransforms: ['condense_history', 'normalize_dates', 'translate', 'expand', 'hyde', 'decompose'] as unknown as QueryLayerConfig['voiceTransforms'] }, { hyde: true });
    const routed = routeTransforms({
      gate: gate(['condense_history', 'decompose', 'expand', 'translate']),
      classification: classified('multi_step', false),
      config: forced,
      profile: 'voice',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(routed.transforms).toEqual(['condense', 'translate']);
    for (const blocked of ['expand', 'hyde', 'decompose']) expect(routed.transforms).not.toContain(blocked);
  });

  test('voice translate runs only when listed; unlisted transforms are disabled', () => {
    const unlisted = routeTransforms({ gate: gate(['translate']), config: layer(), profile: 'voice', embeddingProfileId: EMBEDDING_PROFILE });
    expect(unlisted.transforms).toEqual([]);
    expect(unlisted.skipped).toEqual([{ transform: 'translate', reason: 'disabled', status: 'disabled' }]);
    const listed = routeTransforms({
      gate: gate(['translate']),
      config: layer({ voiceTransforms: ['translate'] }),
      profile: 'voice',
      embeddingProfileId: EMBEDDING_PROFILE,
    });
    expect(listed.transforms).toEqual(['translate']);
  });

  test('framework follows the config outside voice', () => {
    const routed = routeTransforms({ gate: gate(['expand']), config: layer({ framework: 'langchain' }), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(routed.framework).toBe('langchain');
  });

  test('translate is disabled_for_profile when the active embedding profile is listed', () => {
    const config = layer({ translateDisabledProfiles: [EMBEDDING_PROFILE] });
    const routed = routeTransforms({ gate: gate(['translate', 'expand']), config, profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(routed.transforms).toEqual(['expand']);
    expect(routed.skipped).toContainEqual({ transform: 'translate', reason: 'disabled_for_profile', status: 'disabled' });
    const other = routeTransforms({ gate: gate(['translate']), config, profile: 'chat', embeddingProfileId: 'synthetic-profile-b' });
    expect(other.transforms).toEqual(['translate']);
  });

  test('R12 small talk returns skipRetrieval with no transforms', () => {
    const smallTalk = gate([], { reasons: ['R12_SMALL_TALK'], skipRetrieval: true });
    const routed = routeTransforms({ gate: smallTalk, classification: classified('multi_step', false), config: layer(), profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(routed).toEqual({ transforms: [], skipped: [], skipRetrieval: true, framework: 'llamaindex' });
  });

  test('with the layer off nothing runs and retrieval is never skipped', () => {
    const smallTalk = gate([], { reasons: ['R12_SMALL_TALK'], skipRetrieval: true });
    const off = layer({ enabled: false });
    expect(routeTransforms({ gate: smallTalk, config: off, profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE })).toEqual({
      transforms: [],
      skipped: [],
      skipRetrieval: false,
      framework: 'llamaindex',
    });
    const routed = routeTransforms({ gate: gate(['condense_history', 'expand']), classification: classified('multi_step', false), config: off, profile: 'chat', embeddingProfileId: EMBEDDING_PROFILE });
    expect(routed.transforms).toEqual([]);
  });
});
