import { getRagDeps } from '../deps';
import { loadRagConfig } from '../config';
import { createPgvectorBackend } from './pgvector';
import type { RetrievalBackend } from './types';

let override: RetrievalBackend | null = null;
let defaultBackend: RetrievalBackend | null = null;

function buildDefaultBackend(): RetrievalBackend {
  const deps = getRagDeps();
  return createPgvectorBackend({
    adminClient: () => deps.adminClient() as ReturnType<typeof deps.adminClient>,
    getConfig: () => loadRagConfig(deps.ragEnv()),
  });
}

export function getRetrievalBackend(): RetrievalBackend {
  if (override) return override;
  defaultBackend ??= buildDefaultBackend();
  return defaultBackend;
}

export function setRetrievalBackendForTests(backend: RetrievalBackend): void {
  override = backend;
}

export function resetRetrievalBackendForTests(): void {
  override = null;
  defaultBackend = null;
}