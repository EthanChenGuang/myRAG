export interface LangfuseConfig {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  sampleRate: number;
  reviewSampleRate: number;
  captureContent: boolean;
}

export type LangfuseEnvSource = Record<string, string | undefined>;

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';
const DEFAULT_SAMPLE_RATE = 0.1;
const DEFAULT_REVIEW_SAMPLE_RATE = 0;

function parseRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** Read at call time so the toggle and keys are never cached across requests; every value is passed on explicitly. */
export function readLangfuseConfig(source: LangfuseEnvSource = process.env): LangfuseConfig {
  return {
    enabled: source.LANGFUSE_ENABLED === 'true',
    publicKey: source.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: source.LANGFUSE_SECRET_KEY ?? '',
    baseUrl: (source.LANGFUSE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    sampleRate: parseRate(source.LANGFUSE_SAMPLE_RATE, DEFAULT_SAMPLE_RATE),
    reviewSampleRate: parseRate(source.LANGFUSE_REVIEW_SAMPLE_RATE, DEFAULT_REVIEW_SAMPLE_RATE),
    captureContent: source.LANGFUSE_CAPTURE_CONTENT === 'true',
  };
}

export function isLangfuseUsable(config: LangfuseConfig): boolean {
  return config.enabled && config.publicKey !== '' && config.secretKey !== '';
}
