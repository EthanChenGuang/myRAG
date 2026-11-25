export const EMBED_FEEDBACK_AUDIENCE = 'embed-feedback';

export interface EmbedFeedbackTokenClaims {
  traceId: string;
  tenantKey: string;
}

export interface EmbedFeedbackTokenOptions {
  secret?: string | null;
  now?: number;
}

export function mintEmbedFeedbackToken(_input: EmbedFeedbackTokenClaims, _options: EmbedFeedbackTokenOptions = {}): string | null {
  return null;
}

export function verifyEmbedFeedbackToken(_token: unknown, _options: EmbedFeedbackTokenOptions = {}): EmbedFeedbackTokenClaims | null {
  return null;
}
