import OpenAI from 'openai';
import { env } from '@/lib/env';
import { EmbeddingProfileMismatch } from './mrl';
import type { EmbedOptions, EmbedOutput, EmbeddingProvider } from './types';
import { OPENAI_NATIVE_DIMS, toProviderError } from './types';

const BATCH_SIZE = 100;
const MAX_INPUT_TOKENS = 8191;
const HOST = 'openai';

export interface OpenAiEmbeddingsClient {
  embeddings: {
    create(
      body: { model: string; input: string | string[] },
      opts: { signal: AbortSignal },
    ): Promise<{ data: { embedding: number[] }[]; model: string; usage?: { total_tokens?: number } }>;
  };
}

export interface OpenAiProviderOptions {
  client?: () => OpenAiEmbeddingsClient;
}

function configuredModel(): string {
  return env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

export function createOpenAiProvider(options: OpenAiProviderOptions = {}): EmbeddingProvider {
  let lazy: OpenAiEmbeddingsClient | null = null;
  const getClient = (): OpenAiEmbeddingsClient => {
    if (options.client) return options.client();
    if (!lazy) lazy = new OpenAI({ apiKey: env.OPENAI_API_KEY }) as unknown as OpenAiEmbeddingsClient;
    return lazy;
  };

  async function embed(texts: string[], opts: EmbedOptions): Promise<EmbedOutput> {
    if (opts.dims !== OPENAI_NATIVE_DIMS) throw new EmbeddingProfileMismatch('dims', opts.dims, OPENAI_NATIVE_DIMS);
    const model = configuredModel();
    const vectors: number[][] = [];
    let responseModel = model;
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      let response;
      try {
        response = await getClient().embeddings.create(
          { model, input: texts.slice(i, i + BATCH_SIZE) },
          { signal: opts.signal },
        );
      } catch (error) {
        throw toProviderError(error, HOST, opts.signal);
      }
      for (const item of response.data) {
        if (item.embedding.length !== OPENAI_NATIVE_DIMS) {
          throw new EmbeddingProfileMismatch('dims', item.embedding.length, OPENAI_NATIVE_DIMS);
        }
        vectors.push(item.embedding);
      }
      if (response.model) responseModel = response.model;
      tokens += response.usage?.total_tokens || 0;
    }
    return { vectors, model: responseModel, host: HOST, usage: { tokens } };
  }

  return {
    id: 'openai',
    get model() {
      return configuredModel();
    },
    maxInputTokens: MAX_INPUT_TOKENS,
    supportedDims: [OPENAI_NATIVE_DIMS],
    normalize: true,
    embedDocuments: (texts, opts) => embed(texts, opts),
    embedQuery: (text, opts) => embed([text], opts),
  };
}
