import OpenAI from 'openai';
import { env } from '@/lib/env';

const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

function embeddingModel(): string {
  return env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

export async function embedText(text: string, opts: { signal: AbortSignal }): Promise<number[]> {
  const response = await getClient().embeddings.create(
    { model: embeddingModel(), input: text },
    { signal: opts.signal },
  );
  return response.data[0].embedding;
}

export async function embedBatch(
  texts: string[],
  opts: { signal: AbortSignal; onUsage?: (totalTokens: number) => void },
): Promise<number[][]> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const response = await getClient().embeddings.create(
      { model: embeddingModel(), input: texts.slice(i, i + BATCH_SIZE) },
      { signal: opts.signal },
    );
    for (const item of response.data) all.push(item.embedding);
    opts.onUsage?.(response.usage?.total_tokens || 0);
  }
  return all;
}
