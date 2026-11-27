import type { QdrantApi } from '../backend/qdrant/client';
import type { WeaviateClientLike } from '../backend/weaviate/types';

/**
 * D-15 (ADM-01): Test-connection probes. Each probe runs the smallest authenticated call through the app's own adapter with the
 * configuration this process loaded. A result carries only the provider id, a code, a fixed message for that code and the latency:
 * never a key, a URL, a host, a port or anything a vendor sent. Caught errors are mapped to a code and then dropped.
 */

/** Stable contract: the Config UI maps manifest providers to these ids (07-UI-SPEC 6.2.4). Additions only. */
export const PROVIDER_IDS = [
  'embedding:openai',
  'embedding:voyage',
  'embedding:deepinfra',
  'rerank:cohere',
  'rerank:voyage',
  'backend:weaviate',
  'backend:qdrant',
  'sidecar',
  'langfuse',
  'vectara',
  'lakera',
  'llamacloud',
  'anthropic',
  'exa',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Stable contract: the first five failure codes are worded by the Config UI (07-UI-SPEC 8.3); any other code is an addition. */
export const PROVIDER_PROBE_CODES = [
  'not_configured',
  'unauthorized',
  'timeout',
  'unreachable',
  'collection_missing',
  'ok',
  'disabled',
  'invalid_config',
  'rate_limited',
  'provider_error',
  'bad_response',
] as const;

export type ProviderProbeCode = (typeof PROVIDER_PROBE_CODES)[number];

/** The only text a result carries; never interpolated. */
export const PROVIDER_PROBE_MESSAGES: Readonly<Record<ProviderProbeCode, string>> = Object.freeze({
  ok: 'Connected.',
  not_configured: 'Not tested: the running app has no key or URL for this provider.',
  unauthorized: 'The provider refused the key.',
  timeout: 'No answer within 10 seconds.',
  unreachable: 'The provider could not be reached.',
  collection_missing: 'Connected, but the collection for the active embedding profile does not exist yet.',
  disabled: 'Not tested: calls to this provider are turned off in the running app.',
  invalid_config: 'Not tested: the running app has an invalid setting for this provider.',
  rate_limited: 'The provider is rate limiting requests.',
  provider_error: 'The provider answered with an error.',
  bad_response: 'The provider answered with an unexpected response.',
});

export const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

export interface ProviderProbeResult {
  provider: ProviderId;
  ok: boolean;
  latencyMs: number;
  code: ProviderProbeCode;
  message: string;
}

export type ProbeEnv = Record<string, string | undefined>;

export interface ProviderProbeDeps {
  /** The loaded configuration; defaults to the process's env snapshot. */
  env: ProbeEnv;
  fetch: typeof fetch;
  now: () => number;
  activeProfileId: () => Promise<string>;
  /** Builds the Qdrant read client from the loaded URL and read key. */
  qdrantReadClient: (source: ProbeEnv) => QdrantApi;
  /** The Weaviate read client of this process. */
  weaviateReadClient: () => Promise<WeaviateClientLike>;
}

export interface RunProviderProbeOptions {
  signal: AbortSignal;
  deps?: Partial<ProviderProbeDeps>;
}

export async function runProviderProbe(provider: ProviderId, _options: RunProviderProbeOptions): Promise<ProviderProbeResult> {
  return { provider, ok: false, latencyMs: -1, code: 'unreachable', message: 'not implemented' };
}
