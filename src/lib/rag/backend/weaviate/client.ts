import weaviate, { type WeaviateClient } from '@weaviate/node';
import { env } from '@/lib/env';
import type { WeaviateClientLike } from './types';

/** Collection configuration helpers (vector index, inverted index, multi-tenancy, data types); collection.ts builds the spec with them. */
export const weaviateConfigure = weaviate.configure;

export type WeaviateRole = 'read' | 'write';

export interface WeaviateEnv {
  WEAVIATE_URL?: string;
  WEAVIATE_API_KEY?: string;
  WEAVIATE_READ_API_KEY?: string;
  NODE_ENV?: string;
}

export type WeaviateConnection =
  | { kind: 'cloud'; url: string; apiKey: string; skipInitChecks: boolean }
  | {
      kind: 'custom';
      httpHost: string;
      httpPort: number;
      httpSecure: boolean;
      httpPath?: string;
      grpcHost: string;
      grpcPort: number;
      grpcSecure: boolean;
      apiKey: string;
      skipInitChecks: boolean;
    };

export const WEAVIATE_GRPC_PORT = 50051;
const CLOUD_HOST_RE = /\.weaviate\.(?:cloud|network)$/i;

let readKeyFallbackWarned = false;

export class WeaviateConfigError extends Error {
  constructor(reason: string) {
    super(`[RAG Backend] weaviate ${reason}`);
    this.name = 'WeaviateConfigError';
  }
}

/**
 * D-09, A-1: the read path uses WEAVIATE_READ_API_KEY (one warning when it falls back to the write key) and skips the init
 * checks; a Weaviate Cloud host connects as cloud, any other host as a custom connection with gRPC on 50051 of the same host.
 * Production refuses plain http while a key is set.
 */
export function resolveWeaviateConnection(role: WeaviateRole, source: WeaviateEnv): WeaviateConnection {
  const raw = (source.WEAVIATE_URL ?? '').trim();
  if (raw === '') throw new WeaviateConfigError('WEAVIATE_URL is not set');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WeaviateConfigError('WEAVIATE_URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WeaviateConfigError('WEAVIATE_URL must use http or https');
  const writeKey = (source.WEAVIATE_API_KEY ?? '').trim();
  let apiKey = writeKey;
  if (role === 'read') {
    const readKey = (source.WEAVIATE_READ_API_KEY ?? '').trim();
    apiKey = readKey;
    if (readKey === '' && writeKey !== '') {
      apiKey = writeKey;
      if (!readKeyFallbackWarned) {
        readKeyFallbackWarned = true;
        console.warn('[RAG Backend] WEAVIATE_READ_API_KEY is empty; the weaviate read client uses WEAVIATE_API_KEY');
      }
    }
  }
  const secure = url.protocol === 'https:';
  if (!secure && apiKey !== '' && source.NODE_ENV === 'production') {
    throw new WeaviateConfigError('refuses plain http with an API key in production');
  }
  const skipInitChecks = role === 'read';
  if (CLOUD_HOST_RE.test(url.hostname)) {
    if (!secure) throw new WeaviateConfigError('Weaviate Cloud requires https');
    return { kind: 'cloud', url: `https://${url.host}`, apiKey, skipInitChecks };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return {
    kind: 'custom',
    httpHost: url.hostname,
    httpPort: url.port ? Number(url.port) : secure ? 443 : 80,
    httpSecure: secure,
    ...(path ? { httpPath: path } : {}),
    grpcHost: url.hostname,
    grpcPort: WEAVIATE_GRPC_PORT,
    grpcSecure: secure,
    apiKey,
    skipInitChecks,
  };
}

async function connect(connection: WeaviateConnection): Promise<WeaviateClient> {
  const authCredentials = connection.apiKey ? new weaviate.ApiKey(connection.apiKey) : undefined;
  if (connection.kind === 'cloud') {
    return weaviate.connectToWeaviateCloud(connection.url, { authCredentials, skipInitChecks: connection.skipInitChecks });
  }
  const { kind: _kind, apiKey: _apiKey, ...options } = connection;
  return weaviate.connectToCustom({ ...options, authCredentials });
}

function currentEnv(): WeaviateEnv {
  return {
    WEAVIATE_URL: process.env.WEAVIATE_URL ?? env.WEAVIATE_URL,
    WEAVIATE_API_KEY: process.env.WEAVIATE_API_KEY ?? env.WEAVIATE_API_KEY,
    WEAVIATE_READ_API_KEY: process.env.WEAVIATE_READ_API_KEY ?? env.WEAVIATE_READ_API_KEY,
    NODE_ENV: process.env.NODE_ENV,
  };
}

const clients: Partial<Record<WeaviateRole, Promise<WeaviateClientLike>>> = {};

function getClient(role: WeaviateRole): Promise<WeaviateClientLike> {
  const cached = clients[role];
  if (cached) return cached;
  const created = Promise.resolve()
    .then(() => connect(resolveWeaviateConnection(role, currentEnv())))
    .then((client) => client as unknown as WeaviateClientLike);
  clients[role] = created;
  created.catch(() => {
    if (clients[role] === created) delete clients[role];
  });
  return created;
}

/** The retrieval client (read-only key), created once per process. */
export function getWeaviateReadClient(): Promise<WeaviateClientLike> {
  return getClient('read');
}

/** The drain worker's client (write key): collection admin, tenant creation and data writes. Created once per process. */
export function getWeaviateWriteClient(): Promise<WeaviateClientLike> {
  return getClient('write');
}

export function resetWeaviateClientsForTests(): void {
  delete clients.read;
  delete clients.write;
  readKeyFallbackWarned = false;
}
