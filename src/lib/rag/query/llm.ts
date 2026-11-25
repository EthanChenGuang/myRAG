import type { LanguageModel } from 'ai';
import type { ZodType, ZodTypeDef } from 'zod/v3';

export type QueryLlmTransform = 'condense' | 'expand' | 'hyde' | 'decompose' | 'translate';
export type QueryLlmErrorKind = 'unavailable' | 'aborted' | 'invalid_output' | 'error';

export class QueryLlmError extends Error {
  constructor(
    readonly kind: QueryLlmErrorKind,
    readonly transform: QueryLlmTransform,
  ) {
    super(`query LLM ${transform}: ${kind}`);
    this.name = 'QueryLlmError';
  }
}

export interface QueryLlmRequest<T> {
  transform: QueryLlmTransform;
  schema: ZodType<T, ZodTypeDef, unknown>;
  system: string;
  prompt: string;
  input: string;
  signal: AbortSignal;
}

export interface QueryLlm {
  readonly model: string;
  generate<T>(request: QueryLlmRequest<T>): Promise<T>;
}

export interface CreateQueryLlmOptions {
  model?: string;
  apiKey?: () => string | undefined;
  languageModel?: (modelId: string, apiKey: string) => LanguageModel | Promise<LanguageModel>;
}

export function createQueryLlm(options: CreateQueryLlmOptions = {}): QueryLlm {
  return {
    model: options.model ?? '',
    async generate() {
      throw new Error('not implemented');
    },
  };
}

export function resetQueryLlmForTests(): void {}
