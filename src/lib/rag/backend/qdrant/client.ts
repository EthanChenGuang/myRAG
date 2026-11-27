import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '@/lib/env';

export { qdrantErrorStatus } from './errors';

/** The subset of the vendor client the adapter and the store call; tests pass a recording fake with the same shape. */
export type QdrantApi = Pick<
  QdrantClient,
  | 'getCollection'
  | 'createCollection'
  | 'createPayloadIndex'
  | 'deleteCollection'
  | 'upsert'
  | 'delete'
  | 'scroll'
  | 'count'
  | 'queryBatch'
  | 'versionInfo'
>;

export interface QdrantClientSettings {
  url: string;
  apiKey: string;
  readApiKey: string;
  nodeEnv: string | undefined;
}

export interface QdrantClients {
  read: QdrantApi;
  write: QdrantApi;
}

/** Backstops only: the factory (07-12) races the read call against its own budget and the request signal. */
export const QDRANT_READ_TIMEOUT_MS = 2_000;
export const QDRANT_WRITE_TIMEOUT_MS = 30_000;

type Construct = (options: ConstructorParameters<typeof QdrantClient>[0]) => QdrantApi;

const defaultConstruct: Construct = (options) => new QdrantClient(options);

export function qdrantSettingsFromEnv(): QdrantClientSettings {
  return {
    url: env.QDRANT_URL ?? '',
    apiKey: env.QDRANT_API_KEY ?? '',
    readApiKey: env.QDRANT_READ_API_KEY ?? '',
    nodeEnv: process.env.NODE_ENV,
  };
}

let readKeyWarned = false;

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error('[RAG Config] QDRANT_URL is not a valid URL');
  }
}

/**
 * Builds both clients without a version round trip (checkCompatibility false). A production deployment refuses plain http while a
 * key is set, so a key never crosses the network in clear text (V9).
 */
export function buildQdrantClients(
  settings: QdrantClientSettings,
  options: { construct?: Construct; warn?: (message: string) => void } = {},
): QdrantClients {
  const raw = settings.url.trim();
  if (raw.length === 0) throw new Error('[RAG Config] QDRANT_URL is not set');
  const url = parseUrl(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('[RAG Config] QDRANT_URL must be http or https');
  const writeKey = settings.apiKey.trim();
  let readKey = settings.readApiKey.trim();
  if (settings.nodeEnv === 'production' && url.protocol === 'http:' && (writeKey.length > 0 || readKey.length > 0)) {
    throw new Error('[RAG Security] QDRANT_URL must use https in production while an API key is set');
  }
  if (readKey.length === 0 && writeKey.length > 0) {
    readKey = writeKey;
    if (!readKeyWarned) {
      readKeyWarned = true;
      (options.warn ?? console.warn)('[RAG Config] QDRANT_READ_API_KEY is not set; retrieval uses the write key QDRANT_API_KEY');
    }
  }
  const construct = options.construct ?? defaultConstruct;
  const base = { url: url.toString().replace(/\/$/, ''), checkCompatibility: false } as const;
  return {
    read: construct({ ...base, timeout: QDRANT_READ_TIMEOUT_MS, ...(readKey ? { apiKey: readKey } : {}) }),
    write: construct({ ...base, timeout: QDRANT_WRITE_TIMEOUT_MS, ...(writeKey ? { apiKey: writeKey } : {}) }),
  };
}

let cached: QdrantClients | null = null;

function clients(): QdrantClients {
  if (!cached) cached = buildQdrantClients(qdrantSettingsFromEnv());
  return cached;
}

/** The retrieval path: read-only key. */
export function getQdrantReadClient(): QdrantApi {
  return clients().read;
}

/** The drain worker, reconcile and collection admin: write key. */
export function getQdrantWriteClient(): QdrantApi {
  return clients().write;
}

export function resetQdrantClientsForTests(): void {
  cached = null;
  readKeyWarned = false;
}
