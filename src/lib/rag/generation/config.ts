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

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 55000;
const DEFAULT_PREMISE_TOKENS = 3000;
const MIN_PREMISE_TOKENS = 256;
const MAX_PREMISE_TOKENS = 8000;

function isOn(raw: string | undefined): boolean {
  return raw?.trim() === 'true';
}

function parseNumber(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function parseTimeout(raw: string | undefined): number {
  const value = parseNumber(raw);
  if (value === null || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, value);
}

function parsePremiseCap(raw: string | undefined): number {
  const value = parseNumber(raw);
  if (value === null) return DEFAULT_PREMISE_TOKENS;
  return Math.min(MAX_PREMISE_TOKENS, Math.max(MIN_PREMISE_TOKENS, value));
}

/** Read at call time, never cached or logged; an empty ANTHROPIC_BASE_URL means the default (research P-3). */
export function readGenerationConfig(source: GenerationEnvSource = process.env): GenerationConfig {
  const apiKey = source.ANTHROPIC_API_KEY?.trim() ?? '';
  const baseUrl = (source.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  return Object.freeze({
    citations: isOn(source.RAG_CITATIONS),
    claudeCitations: isOn(source.RAG_CLAUDE_CITATIONS),
    anthropicApiKey: apiKey === '' ? null : apiKey,
    anthropicBaseUrl: baseUrl,
    groundedness: isOn(source.RAG_GROUNDEDNESS),
    vectaraOptIn: isOn(source.RAG_GROUNDEDNESS_VECTARA_OPT_IN),
    vectaraMultiTenantAck: isOn(source.RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK),
    groundednessTimeoutMs: parseTimeout(source.RAG_GROUNDEDNESS_TIMEOUT_MS),
    maxPremiseTokens: parsePremiseCap(source.RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS),
    feedback: isOn(source.RAG_ANSWER_FEEDBACK),
  });
}
