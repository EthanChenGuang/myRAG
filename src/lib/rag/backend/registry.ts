import { getRagDeps } from '../deps';
import { loadRagConfig } from '../config';
import { createPgvectorBackend } from './pgvector';
import type { BackendCapabilities, BackendSearchRequest, RetrievalBackend } from './types';

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

export type BackendRouteReason = 'backend_field_unsupported';

export interface BackendRoute {
  backend: RetrievalBackend;
  /** Set when the selected backend lacks a field the request carries and pgvector serves the request instead. */
  reason?: BackendRouteReason;
}

function requiredCapabilities(request: Pick<BackendSearchRequest, 'versionScope' | 'identifiersNorm'>): (keyof BackendCapabilities)[] {
  const needed: (keyof BackendCapabilities)[] = [];
  if (request.versionScope !== undefined && request.versionScope !== 'current') needed.push('versionScope');
  if (request.identifiersNorm !== undefined) needed.push('identifierFilter');
  return needed;
}

/**
 * The backend that serves a request (research pitfall 13): the selected one when it declares every optional field the request carries,
 * otherwise the pgvector backend, which honours them all, with reason backend_field_unsupported. A request without such a field always
 * gets the selected backend.
 */
export function backendForRequest(request: Pick<BackendSearchRequest, 'versionScope' | 'identifiersNorm'>): BackendRoute {
  const selected = getRetrievalBackend();
  const needed = requiredCapabilities(request);
  if (needed.every((field) => selected.capabilities?.[field] === true)) return { backend: selected };
  defaultBackend ??= buildDefaultBackend();
  return { backend: defaultBackend, reason: 'backend_field_unsupported' };
}

export function setRetrievalBackendForTests(backend: RetrievalBackend): void {
  override = backend;
}

export function resetRetrievalBackendForTests(): void {
  override = null;
  defaultBackend = null;
}