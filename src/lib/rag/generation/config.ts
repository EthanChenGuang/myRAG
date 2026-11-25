export interface GenerationConfig {
  readonly citations: boolean;
  readonly claudeCitations: boolean;
  readonly anthropicApiKey: string | null;
  readonly anthropicBaseUrl: string;
  readonly groundedness: boolean;
  readonly vectaraOptIn: boolean;
  readonly vectaraMultiTenantAck: boolean;
  readonly groundednessTimeoutMs: number;
  readonly maxPremiseTokens: number;
  readonly feedback: boolean;
}

export type GenerationEnvSource = Record<string, string | undefined>;

export const DEFAULT_ANTHROPIC_BASE_URL = '';

export function readGenerationConfig(_source: GenerationEnvSource = process.env): GenerationConfig {
  return {} as GenerationConfig;
}
