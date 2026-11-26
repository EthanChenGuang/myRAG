import type { Glossary } from './glossary';

export const TRANSLATION_INPUT_TOKEN_LIMIT = 4000;

export type TranslationGapReason = 'too_long' | 'protected_token_lost' | 'empty_output' | 'invalid_output';

export interface ChunkTranslationRequest {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  protectedTokens: readonly string[];
  glossary: Glossary;
  signal: AbortSignal;
}

export interface ChunkTranslationModel {
  readonly model: string;
  translate(request: ChunkTranslationRequest): Promise<unknown>;
}

export type ChunkTranslationOutcome =
  | { ok: true; content: string; attempts: number }
  | { ok: false; reason: TranslationGapReason; attempts: number };

export interface TranslateChunkOptions {
  sourceLanguage: string;
  targetLanguage: string;
  model: ChunkTranslationModel;
  signal: AbortSignal;
  glossary?: Glossary;
  maxInputTokens?: number;
}

export class TranslationModelUnavailable extends Error {
  constructor(readonly kind: string) {
    super(`[Translation] model unavailable (${kind})`);
    this.name = 'TranslationModelUnavailable';
  }
}

export async function translateChunk(_text: string, _options: TranslateChunkOptions): Promise<ChunkTranslationOutcome> {
  return { ok: false, reason: 'invalid_output', attempts: 0 };
}

export function createLlmChunkTranslationModel(model: string, _llm?: unknown): ChunkTranslationModel {
  return { model, translate: async () => null };
}

export function createFixtureChunkTranslationModel(_table: unknown): ChunkTranslationModel & { calls: ChunkTranslationRequest[] } {
  return { model: 'fixture-translator', calls: [], translate: async () => null };
}

export function resetChunkTranslationModelForTests(): void {}

export function setChunkTranslationModelForTests(_model: ChunkTranslationModel): void {}
