import type { UIMessage } from 'ai';

export interface EmbedRequestBody {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  model: string;
}

export function toEmbedRequestBody(_messages: UIMessage[], model: string): EmbedRequestBody {
  return { messages: [], model };
}
