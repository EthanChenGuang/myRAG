import { LEXICAL_SCORING_DEFAULTS, type RagConfig } from '../config';
import type { VectorStore, VectorSyncTarget } from '../sync/stores/types';
import { BackendNotReadyError } from './external';

/** The BM25 pair an external store scores its lexical leg with (LEX-05). */
export interface LexicalParams {
  k1: number;
  b: number;
}

/** The collection metadata key both stores record their pair under. */
export const LEXICAL_BM25_KEY = 'lexical_bm25';
export const LEXICAL_PARAMS_MISMATCH = 'lexical_params_mismatch';

/** Weaviate keeps k1 and b in the collection's inverted index; Qdrant 1.20 takes them per query (TextQueryInput.scoring.bm25). */
export type LexicalBinding = 'index' | 'query';
export const LEXICAL_BINDING: Readonly<Record<VectorSyncTarget, LexicalBinding>> = Object.freeze({ weaviate: 'index', qdrant: 'query' });

export function defaultLexicalParams(): LexicalParams {
  return { k1: LEXICAL_SCORING_DEFAULTS.k1, b: LEXICAL_SCORING_DEFAULTS.b };
}

/**
 * The pair every external backend uses, from server configuration only (04.4 D-28). While the effective mode is ts_rank_cd the
 * defaults apply whatever RAG_LEXICAL_BM25_K1 and RAG_LEXICAL_BM25_B say, so the off state builds today's collections and requests.
 */
export function externalLexicalParams(config: Pick<RagConfig, 'v2'>): LexicalParams {
  const scoring = config.v2.lexicalScoring;
  return scoring.mode === 'bm25' ? { k1: scoring.k1, b: scoring.b } : defaultLexicalParams();
}

export function sameLexicalParams(a: LexicalParams, b: LexicalParams): boolean {
  return a.k1 === b.k1 && a.b === b.b;
}

export function isDefaultLexicalParams(params: LexicalParams): boolean {
  return sameLexicalParams(params, defaultLexicalParams());
}

/** The stored value of lexical_bm25; a collection created before LEX-05 has none and was built with the defaults. */
export function recordedLexicalParams(raw: unknown): LexicalParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultLexicalParams();
  const { k1, b } = raw as Record<string, unknown>;
  if (typeof k1 !== 'number' || !Number.isFinite(k1) || typeof b !== 'number' || !Number.isFinite(b)) return defaultLexicalParams();
  return { k1, b };
}

export function lexicalParamsRecord(params: LexicalParams): { k1: number; b: number } {
  return { k1: params.k1, b: params.b };
}

function pair(params: LexicalParams): string {
  return `k1 ${params.k1}, b ${params.b}`;
}

export function rebuildLexicalCommand(target: VectorSyncTarget): string {
  return `npm run rag:vector-sync -- rebuild-lexical --target ${target} --confirm`;
}

/** One sentence: target, profile id, both pairs and the rebuild command; never a tenant key or stored text. */
export function lexicalParamsMismatchMessage(
  target: VectorSyncTarget,
  profileId: string,
  recorded: LexicalParams,
  configured: LexicalParams,
): string {
  return (
    `[RAG Backend] ${target} collection for profile ${profileId} was built with BM25 ${pair(recorded)} but the configuration says ` +
    `${pair(configured)}; it is not served until \`${rebuildLexicalCommand(target)}\` rebuilds it`
  );
}

/** An index built with another pair; the factory maps it to backend_not_ready like any BackendNotReadyError. */
export class LexicalParamsMismatchError extends BackendNotReadyError {
  readonly lexicalReason = LEXICAL_PARAMS_MISMATCH;
  readonly profileId: string;
  readonly recorded: LexicalParams;
  readonly configured: LexicalParams;

  constructor(target: VectorSyncTarget, profileId: string, recorded: LexicalParams, configured: LexicalParams) {
    super(target, 'collection_missing');
    this.name = 'LexicalParamsMismatchError';
    this.message = lexicalParamsMismatchMessage(target, profileId, recorded, configured);
    this.profileId = profileId;
    this.recorded = { ...recorded };
    this.configured = { ...configured };
  }
}

/** Equals READINESS_TTL_MS of readiness.ts (asserted by a test); kept local so this module does not load the deps graph. */
export const LEXICAL_PARAMS_CHECK_TTL_MS = 30_000;

export type LexicalParamsSource = () => LexicalParams | Promise<LexicalParams>;

/** The default source: the loaded server configuration (memoised by loadRagConfig). */
export const configuredLexicalParams: LexicalParamsSource = async () => {
  const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../config'), import('../deps')]);
  return externalLexicalParams(loadRagConfig(getRagDeps().ragEnv()));
};

/** What the rebuild-lexical command needs beyond VectorStore. */
export interface LexicalParamsStore {
  readonly lexicalBinding: LexicalBinding;
  /** The pair the collection records; null when the profile has no collection. */
  recordedLexicalParams(profileId: string): Promise<LexicalParams | null>;
  /** The pair this store builds collections and queries with. */
  configuredLexicalParams(): Promise<LexicalParams>;
  /** Index-bound: drops the collection and creates it again with the configured pair. Query-bound: refreshes the record only. */
  rebuildLexical(profileId: string, dims: number): Promise<void>;
}

export function isLexicalParamsStore(store: VectorStore): store is VectorStore & LexicalParamsStore {
  const candidate = store as Partial<LexicalParamsStore>;
  return (
    (candidate.lexicalBinding === 'index' || candidate.lexicalBinding === 'query') &&
    typeof candidate.recordedLexicalParams === 'function' &&
    typeof candidate.rebuildLexical === 'function'
  );
}

interface CheckEntry {
  at: number;
  error: LexicalParamsMismatchError | null;
}

const checks = new Map<string, CheckEntry>();

export function resetLexicalParamsChecks(): void {
  checks.clear();
}

export interface LexicalParamsCheckDeps {
  target: VectorSyncTarget;
  /** The recorded pair (read client); null when the collection does not exist. A throw is not a mismatch. */
  describe: (profileId: string) => Promise<LexicalParams | null>;
  configured?: LexicalParamsSource;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Read-side guard for an index-bound store: at most one describe call per LEXICAL_PARAMS_CHECK_TTL_MS per (target, profile, configured pair) and
 * process. A differing pair throws LexicalParamsMismatchError before any query and logs one line per window; a failed describe lets
 * the search proceed under its own error mapping.
 */
export function createLexicalParamsCheck(deps: LexicalParamsCheckDeps): (profileId: string) => Promise<void> {
  const configured = deps.configured ?? configuredLexicalParams;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const now = deps.now ?? Date.now;
  return async (profileId: string) => {
    const want = await configured();
    const key = `${deps.target}|${profileId}|${want.k1}|${want.b}`;
    const at = now();
    const cached = checks.get(key);
    if (cached && at - cached.at < LEXICAL_PARAMS_CHECK_TTL_MS) {
      if (cached.error) throw cached.error;
      return;
    }
    let error: LexicalParamsMismatchError | null = null;
    try {
      const recorded = await deps.describe(profileId);
      if (recorded && !sameLexicalParams(recorded, want)) error = new LexicalParamsMismatchError(deps.target, profileId, recorded, want);
    } catch {
      error = null;
    }
    checks.set(key, { at, error });
    if (error) {
      log(error.message);
      throw error;
    }
  };
}
