import type { UIMessage } from 'ai';

export interface EmbedRequestBody {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  model: string;
}

export function toEmbedRequestBody(messages: UIMessage[], model: string): EmbedRequestBody {
  return {
    messages: messages.map((message) => ({
      role: message.role,
      content: message.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(''),
    })),
    model,
  };
}
