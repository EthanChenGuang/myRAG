import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type LanguageModel } from 'ai';
import type { ZodType, ZodTypeDef } from 'zod/v3';
import { env, getAppName } from '@/lib/env';
import type { QueryTranslation } from '@/lib/rag-eval/contracts.generated';

export type QueryLlmTransform = 'condense' | 'expand' | 'hyde' | 'decompose' | 'translate';
export type QueryLlmErrorKind = 'unavailable' | 'aborted' | 'invalid_output' | 'error';

/** The message names only the transform and the kind: never the prompt, the output or provider text that could echo a key. */
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
  /** A generated zod/v3 contract schema; the output is validated against it again after the SDK parse. */
  schema: ZodType<T, ZodTypeDef, unknown>;
  system: string;
  prompt: string;
  /** The query the transform works on; the real client ignores it (it is in the prompt), the fake keys on it. */
  input: string;
  /** translate only: the language asked for; the real client has it in the prompt, the fake keys on it. */
  targetLanguage?: QueryTranslation['target_language'];
  signal: AbortSignal;
}

export interface QueryLlm {
  readonly model: string;
  generate<T>(request: QueryLlmRequest<T>): Promise<T>;
}

export interface CreateQueryLlmOptions {
  model?: string;
  apiKey?: () => string | undefined;
  /** Test seam; the default builds the OpenRouter AI SDK model on first use. */
  languageModel?: (modelId: string, apiKey: string) => LanguageModel | Promise<LanguageModel>;
}

export const DEFAULT_QUERY_LLM_MODEL_ID = 'openai/gpt-4.1-nano';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

let missingKeyLogged = false;

function readApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY;
}

function siteUrl(): string {
  return (
    env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  );
}

/** The provider module is imported on the first call, so loading RagDeps never pulls it in. */
async function openRouterModel(modelId: string, apiKey: string): Promise<LanguageModel> {
  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const provider = createOpenRouter({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    headers: { 'HTTP-Referer': siteUrl(), 'X-Title': getAppName() },
  });
  return provider(modelId, {
    provider: { require_parameters: true, data_collection: 'deny', sort: 'latency' },
  }) as LanguageModel;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function createQueryLlm(options: CreateQueryLlmOptions = {}): QueryLlm {
  const modelId = (options.model ?? '').trim() || DEFAULT_QUERY_LLM_MODEL_ID;
  const apiKeyOf = options.apiKey ?? readApiKey;
  const buildModel = options.languageModel ?? openRouterModel;
  let cached: { key: string; model: Promise<LanguageModel> } | null = null;

  function modelFor(key: string): Promise<LanguageModel> {
    if (!cached || cached.key !== key) cached = { key, model: Promise.resolve(buildModel(modelId, key)) };
    return cached.model;
  }

  return {
    model: modelId,
    async generate<T>(request: QueryLlmRequest<T>): Promise<T> {
      const { transform, schema, signal } = request;
      const key = (apiKeyOf() ?? '').trim();
      if (key === '') {
        if (!missingKeyLogged) {
          missingKeyLogged = true;
          console.warn('[Query Layer] OPENROUTER_API_KEY is not configured; query-layer transforms are skipped', { configured: false });
        }
        throw new QueryLlmError('unavailable', transform);
      }
      if (signal.aborted) throw new QueryLlmError('aborted', transform);

      let output: unknown;
      try {
        const result = await generateText({
          model: await modelFor(key),
          output: Output.object({ schema }),
          system: request.system,
          prompt: request.prompt,
          temperature: 0,
          maxRetries: 0,
          abortSignal: signal,
        });
        output = result.output;
      } catch (error) {
        if (isAbort(error, signal)) throw new QueryLlmError('aborted', transform);
        if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
          throw new QueryLlmError('invalid_output', transform);
        }
        throw new QueryLlmError('error', transform);
      }

      const parsed = schema.safeParse(output);
      if (!parsed.success) throw new QueryLlmError('invalid_output', transform);
      return parsed.data;
    },
  };
}

export function resetQueryLlmForTests(): void {
  missingKeyLogged = false;
}
