import type { ClaimJudgement } from '../../src/lib/rag-eval/contracts.generated.ts';
import type { GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { installFakeCitationGenerator, type FakeLanguageModelFactory } from './fake-citation-generator.mts';

/** Harness-only scripted answer models for the Phase 5.2 gates (skeleton). Never imported by src/. */
export const FAKE_ANSWER_MODEL_IDS: readonly string[] = [];

export function fakeJudgeClaims(_input: { premises: unknown[]; claims: unknown[] }): ClaimJudgement {
  return { judgements: [] };
}

export function installFakeAnswerModels(_options: { items: readonly GoldenItem[] }): FakeLanguageModelFactory {
  return installFakeCitationGenerator();
}
