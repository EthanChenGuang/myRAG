import budgetsJson from '../../../../eval/config/latency-budgets.json';
import type { BackendConfig, RagConfig } from '../config';
import { getRagDeps } from '../deps';
import type { BackendDegradedReason, BackendFallbackReason, Profile, RetrievalBackendSelection, RetrievalOverrides } from '../types';
import { BackendNotReadyError } from './external';
import { isBackendReady, type ExternalBackendTarget } from './readiness';
import { getRetrievalBackend } from './registry';
import { RetrievalBackendError, type RpcClient } from './supabase-rpc';
import type { BackendId, BackendLegs, BackendSearchRequest, RetrievalBackend } from './types';

/** D-11: the external search timeout for every entry point but eval, which waits for the external answer. */
export const EXTERNAL_SEARCH_TIMEOUT_MS = 800;

export interface ResolvedRetrievalBackend {
  /** The backend the search stage calls: the registry's pgvector backend itself, or a wrapper that falls back to it. */
  backend: RetrievalBackend;
  /** The configured choice for this entry point (D-24). */
  choice: BackendId;
  /** What served the request so far; read once the search stage is done. */
  selection(): RetrievalBackendSelection;
  /** RET-05: the ids the external re-validation dropped in this request, deduplicated; for the stale repair only, never traced. */
  staleChunkIds(): string[];
}

export interface ResolveBackendOptions {
  /** Defaults to the admin client. */
  readinessRpc?: RpcClient | null;
  /** A-8: the race budget; defaults to the profile's search budget in eval/config/latency-budgets.json (none for eval). */
  searchBudgetMs?: number | null;
}

type ExternalSource = RetrievalBackend | (() => RetrievalBackend | Promise<RetrievalBackend>);

const testExternals = new Map<ExternalBackendTarget, ExternalSource>();
const builtExternals = new Map<ExternalBackendTarget, RetrievalBackend>();
let legacyWarned = false;

function isExternal(id: BackendId): id is ExternalBackendTarget {
  return id === 'weaviate' || id === 'qdrant';
}

/** D-24: voice reads RAG_RETRIEVAL_BACKEND_VOICE; eval may override per request; every other entry point reads the default. */
export function selectedBackendId(profile: Profile, config: Pick<RagConfig, 'pipeline' | 'backend'>, overrides?: RetrievalOverrides): BackendId {
  if (config.pipeline !== 'v2') return 'pgvector';
  if (profile === 'voice') return config.backend.voice;
  if (profile === 'eval' && overrides?.backend) return overrides.backend;
  return config.backend.default;
}

interface ProfileBudget {
  stages?: Record<string, number>;
}

function profileSearchBudget(profile: Profile): number | null {
  if (profile === 'eval') return null;
  const profiles = (budgetsJson as { profiles?: Record<string, ProfileBudget> }).profiles ?? {};
  const budget = profiles[profile]?.stages?.search;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : null;
}

async function buildExternal(id: ExternalBackendTarget): Promise<RetrievalBackend> {
  const source = testExternals.get(id);
  if (source) return typeof source === 'function' ? source() : source;
  const cached = builtExternals.get(id);
  if (cached) return cached;
  const deps = getRagDeps();
  const admin = () => deps.adminClient() as unknown as RpcClient | null;
  let backend: RetrievalBackend;
  if (id === 'qdrant') {
    const [{ createQdrantBackend }, { getQdrantReadClient }] = await Promise.all([import('./qdrant/adapter'), import('./qdrant/client')]);
    backend = createQdrantBackend({ readClient: getQdrantReadClient(), adminClient: admin });
  } else {
    const [{ createWeaviateBackend }, { getWeaviateReadClient }] = await Promise.all([import('./weaviate/adapter'), import('./weaviate/client')]);
    backend = createWeaviateBackend({ readClient: () => getWeaviateReadClient(), revalidate: admin });
  }
  builtExternals.set(id, backend);
  return backend;
}

function classifyFailure(error: unknown): BackendFallbackReason {
  if (error instanceof BackendNotReadyError) return 'backend_not_ready';
  if (error instanceof RetrievalBackendError && error.code === 'filter_unsupported') return 'filter_unsupported';
  return 'backend_error';
}

function linkedController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
  return controller;
}

class ExternalTimeoutError extends Error {
  constructor() {
    super('[RAG Backend] external search timed out');
    this.name = 'ExternalTimeoutError';
  }
}

class SlowExternalError extends Error {
  constructor() {
    super('[RAG Backend] pgvector answered first');
    this.name = 'SlowExternalError';
  }
}

const DEGRADED: ReadonlySet<BackendFallbackReason> = new Set<BackendDegradedReason>(['backend_not_ready', 'backend_error', 'backend_slow']);

/**
 * One request's view of an external backend (D-11, A-8). Readiness is read once per embedding profile; a not-ready store, an
 * error, a timeout or a filter the store cannot hold runs pgvector for that call in the same request. Past the search budget
 * pgvector starts beside the external call and the first valid answer wins; the loser is aborted.
 */
function createFallbackBackend(input: {
  choice: ExternalBackendTarget;
  pgvector: RetrievalBackend;
  backendConfig: BackendConfig;
  timeoutMs: number | null;
  budgetMs: number | null;
  readinessRpc: RpcClient | null | undefined;
}): ResolvedRetrievalBackend {
  const { choice, pgvector } = input;
  const readiness = new Map<string, Promise<boolean>>();
  let fallbackReason: BackendFallbackReason | null = null;
  let tenantValidationDropped = 0;
  let calls = 0;
  let externalServed = 0;
  const recheckChecked = new Set<string>();
  const recheckDropped = new Set<string>();
  let everyServedRechecked = true;

  const note = (reason: BackendFallbackReason) => {
    // A degrading reason outranks filter_unsupported; the first degrading reason of the request is the one reported.
    if (fallbackReason === null || (!DEGRADED.has(fallbackReason) && DEGRADED.has(reason))) fallbackReason = reason;
  };

  const readyFor = (req: BackendSearchRequest): Promise<boolean> => {
    let pending = readiness.get(req.embeddingProfileId);
    if (!pending) {
      pending = isBackendReady({
        target: choice,
        profileId: req.embeddingProfileId,
        scope: req.scope,
        config: input.backendConfig,
        ...(input.readinessRpc !== undefined ? { rpc: input.readinessRpc } : {}),
      });
      readiness.set(req.embeddingProfileId, pending);
    }
    return pending;
  };

  const viaPgvector = async (req: BackendSearchRequest, reason: BackendFallbackReason): Promise<BackendLegs> => {
    note(reason);
    return pgvector.search(req);
  };

  const race = (external: RetrievalBackend, req: BackendSearchRequest): Promise<BackendLegs> =>
    new Promise<BackendLegs>((resolve, reject) => {
      const parent = req.signal;
      const extController = linkedController(parent);
      let pgController: AbortController | null = null;
      let pgPending: Promise<BackendLegs> | null = null;
      let pgError: { error: unknown } | null = null;
      let extFailure: BackendFallbackReason | null = null;
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];

      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        action();
      };

      const onPgSettled = (legs: BackendLegs | null, error?: unknown) => {
        if (settled) return;
        if (legs) {
          if (extFailure !== null) return finish(() => { note(extFailure!); resolve(legs); });
          return finish(() => {
            extController.abort(new SlowExternalError());
            note('backend_slow');
            resolve(legs);
          });
        }
        pgError = { error };
        if (extFailure !== null) finish(() => { note(extFailure!); reject(error); });
      };

      const startPgvector = () => {
        if (pgPending || settled) return;
        pgController = linkedController(parent);
        pgPending = pgvector.search({ ...req, signal: pgController.signal });
        pgPending.then((legs) => onPgSettled(legs), (error) => onPgSettled(null, error));
      };

      const onExternalFailure = (error: unknown) => {
        if (settled || extFailure !== null) return;
        if (parent.aborted) return finish(() => reject(error));
        extFailure = error instanceof ExternalTimeoutError ? 'backend_error' : classifyFailure(error);
        if (pgError) return finish(() => { note(extFailure!); reject(pgError!.error); });
        startPgvector();
      };

      if (input.budgetMs !== null && (input.timeoutMs === null || input.budgetMs < input.timeoutMs)) {
        timers.push(setTimeout(startPgvector, input.budgetMs));
      }
      if (input.timeoutMs !== null) {
        timers.push(
          setTimeout(() => {
            const timeout = new ExternalTimeoutError();
            extController.abort(timeout);
            onExternalFailure(timeout);
          }, input.timeoutMs),
        );
      }

      let externalCall: Promise<BackendLegs>;
      try {
        externalCall = external.search({ ...req, signal: extController.signal });
      } catch (error) {
        externalCall = Promise.reject(error);
      }
      externalCall.then(
        (legs) => {
          if (settled || extFailure !== null) return;
          finish(() => {
            pgController?.abort(new Error('[RAG Backend] external answered first'));
            externalServed += 1;
            tenantValidationDropped += legs.meta?.tenantValidationDropped ?? 0;
            const ids = legs.meta?.sourceRecheckIds;
            if (ids) {
              for (const id of ids.checked) recheckChecked.add(id);
              for (const id of ids.dropped) recheckDropped.add(id);
            } else {
              everyServedRechecked = false;
            }
            resolve(legs);
          });
        },
        onExternalFailure,
      );
    });

  const wrapper: RetrievalBackend = {
    id: choice,
    async search(req) {
      calls += 1;
      if (!(await readyFor(req))) return viaPgvector(req, 'backend_not_ready');
      req.signal.throwIfAborted();
      let external: RetrievalBackend;
      try {
        external = await buildExternal(choice);
      } catch {
        console.warn('[RAG Backend] external backend unavailable, using pgvector', { backend: choice });
        return viaPgvector(req, 'backend_error');
      }
      return race(external, req);
    },
    ...(pgvector.searchTranslations ? { searchTranslations: pgvector.searchTranslations.bind(pgvector) } : {}),
    async health() {
      return (await buildExternal(choice)).health();
    },
    async isReady(scope) {
      return (await buildExternal(choice)).isReady(scope);
    },
  };

  return {
    backend: wrapper,
    choice,
    selection() {
      const reason = fallbackReason as BackendFallbackReason | null;
      const servedExternally = calls === 0 || externalServed === calls;
      const backend = reason === null && servedExternally ? choice : 'pgvector';
      // RET-05: the marker only when every call was served externally; a pgvector fallback follows RAG_SOURCE_RECHECK instead.
      const marked = backend === choice && externalServed > 0 && everyServedRechecked;
      return {
        backend,
        fallbackReason: reason,
        tenantValidationDropped,
        degraded: reason !== null && DEGRADED.has(reason),
        ...(marked ? { sourceRecheck: { checked: recheckChecked.size, dropped: recheckDropped.size } } : {}),
      };
    },
    staleChunkIds: () => [...recheckDropped],
  };
}

/**
 * D-11, D-24: the backend of one request, under RAG_PIPELINE=v2 only. pgvector returns the registry's backend itself with no
 * readiness read; an external choice returns a wrapper that falls back to pgvector in the same request.
 */
export function resolveRetrievalBackend(
  profile: Profile,
  config: Pick<RagConfig, 'pipeline' | 'backend'>,
  overrides?: RetrievalOverrides,
  options: ResolveBackendOptions = {},
): ResolvedRetrievalBackend {
  const pgvector = getRetrievalBackend();
  const choice = selectedBackendId(profile, config, overrides);
  if (!isExternal(choice)) {
    return {
      backend: pgvector,
      choice,
      selection: () => ({ backend: pgvector.id, fallbackReason: null, tenantValidationDropped: 0, degraded: false }),
      staleChunkIds: () => [],
    };
  }
  return createFallbackBackend({
    choice,
    pgvector,
    backendConfig: config.backend,
    timeoutMs: profile === 'eval' ? null : EXTERNAL_SEARCH_TIMEOUT_MS,
    budgetMs: options.searchBudgetMs !== undefined ? options.searchBudgetMs : profileSearchBudget(profile),
    readinessRpc: options.readinessRpc,
  });
}

/** D-11: under RAG_PIPELINE=legacy an external backend setting is ignored; logged once per process. */
export function warnBackendIgnoredOnLegacy(backend: Pick<BackendConfig, 'default' | 'voice'>): void {
  if (legacyWarned || (backend.default === 'pgvector' && backend.voice === 'pgvector')) return;
  legacyWarned = true;
  console.warn('[RAG Config] RAG_RETRIEVAL_BACKEND and RAG_RETRIEVAL_BACKEND_VOICE need RAG_PIPELINE=v2; pgvector serves retrieval', {
    backend: backend.default,
    voice: backend.voice,
  });
}

export function setExternalBackendForTests(id: ExternalBackendTarget, backend: ExternalSource | null): void {
  if (backend) testExternals.set(id, backend);
  else testExternals.delete(id);
}

export function resetBackendFactoryForTests(): void {
  testExternals.clear();
  builtExternals.clear();
  legacyWarned = false;
}
