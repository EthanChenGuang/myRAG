import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

export const FAKE_CITATION_GENERATOR_MODEL = 'fake/citation-alias-v1';

export type FakeLanguageModelFactory = (_modelId: string) => LanguageModel;

export function fakeCitationAnswer(_input: { system: string; question: string; seed?: string }): string {
  return '';
}

export function splitForStreaming(text: string): string[] {
  return [text];
}

export function installFakeCitationGenerator(_seed = 'p5-22'): FakeLanguageModelFactory {
  return () => new MockLanguageModelV3({}) as unknown as LanguageModel;
}
