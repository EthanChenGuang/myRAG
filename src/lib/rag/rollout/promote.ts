import { z } from 'zod/v3';
import rawPolicy from '../../../../config/rag/rollout-policy.json';
import type { LanguageQualityCell } from '@/lib/rag-eval/contracts.generated';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import {
  languageCountMeasure,
  languageJudgeMean,
  languageJudgeMetrics,
  toLanguageQualityCells,
  type LanguageCountMetric,
  type LanguageJudgeCell,
  type LanguageQualityCellRow,
} from '../monitor/language-drop';
import { inCandidateArm, parseActiveRollout, type ActiveRollout, type RolloutKind } from './resolve';

/**
 * LANG-11 with LANG-10 (plan 07-49): a rollout reaches full activation only when every enabled language of the candidate-arm
 * workspaces held over the observation window against the same workspaces' equally long window before the rollout started.
 * Counts, codes and ids only; the salt never leaves this module.
 */

const DAY_MS = 86_400_000;
const UNDETERMINED = 'und';

export const ROLLOUT_MEASURES = ['refusal_rate', 'not_helpful_rate', 'judge_score'] as const;
export type RolloutMeasure = (typeof ROLLOUT_MEASURES)[number];
export type RolloutVerdict = 'holds' | 'worse' | 'insufficient' | 'unmeasured';

const MetricPolicySchema = z.object({ band: z.number().min(0).max(1), required: z.boolean() }).strict();
export const RolloutPolicySchema = z
  .object({
    schema_version: z.literal(1),
    observation_days: z.number().int().min(1).max(90),
    min_samples: z.number().int().min(1),
    max_window_days: z.number().int().min(1).max(180),
    metrics: z.object({ refusal_rate: MetricPolicySchema, not_helpful_rate: MetricPolicySchema, judge_score: MetricPolicySchema }).strict(),
  })
  .strict();
export type RolloutPolicy = z.infer<typeof RolloutPolicySchema>;

/** The committed policy (config/rag/rollout-policy.json), changed only by review. */
export function rolloutPolicy(): RolloutPolicy {
  const parsed = RolloutPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) throw new Error('[RAG Rollout] config/rag/rollout-policy.json is invalid');
  return parsed.data;
}

export interface RolloutValue {
  value: number | null;
  n: number;
}

export interface RolloutMeasureRow {
  measure: RolloutMeasure;
  candidate: RolloutValue;
  before: RolloutValue;
  others: RolloutValue;
  verdict: RolloutVerdict;
}

export interface RolloutLanguageRow {
  language: string;
  measures: RolloutMeasureRow[];
}

export interface RolloutArmCells {
  candidateNow: readonly LanguageQualityCell[];
  candidateBefore: readonly LanguageQualityCell[];
  othersNow: readonly LanguageQualityCell[];
}

export interface RolloutJudgeCells {
  candidateNow: readonly LanguageJudgeCell[];
  candidateBefore: readonly LanguageJudgeCell[];
  othersNow: readonly LanguageJudgeCell[];
}

export interface RolloutComparison {
  languages: RolloutLanguageRow[];
  /** The first refusal in language order (a drop before missing data within a language), null when every language holds. */
  refusal: string | null;
}

const COUNT_METRIC: Record<Exclude<RolloutMeasure, 'judge_score'>, LanguageCountMetric> = {
  refusal_rate: 'refusal_rate',
  not_helpful_rate: 'not_helpful_rate',
};

function ofLanguage<T extends { language: string }>(cells: readonly T[], language: string): T[] {
  return cells.filter((cell) => cell.language === language);
}

function countValue(cells: readonly LanguageQualityCell[], metric: LanguageCountMetric): RolloutValue {
  const measured = languageCountMeasure(cells, metric);
  return { value: measured.rate, n: measured.n };
}

/**
 * Pure: per enabled language and measure, the candidate workspaces now, the same workspaces before, the other workspaces now and
 * the verdict. A required measure with fewer than min_samples in either candidate window is insufficient (blocks); an optional one
 * is unmeasured (does not block). Worse means the rate rose, or the judge score fell, by more than the band. Same metric code as
 * evaluateLanguageDrop (languageCountMeasure, languageJudgeMean).
 */
export function compareRolloutLanguages(input: {
  languages: readonly string[];
  cells: RolloutArmCells;
  judge: RolloutJudgeCells | null;
  policy: RolloutPolicy;
}): RolloutComparison {
  const { policy } = input;
  const judgeMetrics = input.judge ? languageJudgeMetrics(input.judge.candidateNow, input.judge.candidateBefore) : [];
  const languages: RolloutLanguageRow[] = [];
  let drop: string | null = null;
  let insufficient: string | null = null;

  for (const language of [...new Set(input.languages)].filter((code) => code !== UNDETERMINED).sort()) {
    const measures: RolloutMeasureRow[] = [];
    for (const measure of ROLLOUT_MEASURES) {
      const rule = policy.metrics[measure];
      let candidate: RolloutValue;
      let before: RolloutValue;
      let others: RolloutValue;
      if (measure === 'judge_score') {
        if (!input.judge) {
          candidate = before = others = { value: null, n: 0 };
        } else {
          const mean = (cells: readonly LanguageJudgeCell[]) => {
            const value = languageJudgeMean(ofLanguage(cells, language), judgeMetrics);
            return { value: value.mean, n: value.n };
          };
          candidate = mean(input.judge.candidateNow);
          before = mean(input.judge.candidateBefore);
          others = mean(input.judge.othersNow);
        }
      } else {
        const metric = COUNT_METRIC[measure];
        candidate = countValue(ofLanguage(input.cells.candidateNow, language), metric);
        before = countValue(ofLanguage(input.cells.candidateBefore, language), metric);
        others = countValue(ofLanguage(input.cells.othersNow, language), metric);
      }
      let verdict: RolloutVerdict;
      const enough = candidate.n >= policy.min_samples && before.n >= policy.min_samples && candidate.value !== null && before.value !== null;
      if (!enough) {
        verdict = rule.required ? 'insufficient' : 'unmeasured';
      } else {
        const delta = measure === 'judge_score' ? (before.value as number) - (candidate.value as number) : (candidate.value as number) - (before.value as number);
        verdict = delta > rule.band + 1e-9 ? 'worse' : 'holds';
      }
      if (verdict === 'worse' && drop === null) drop = `rollout_language_drop:${language}:${measure}`;
      if (verdict === 'insufficient' && insufficient === null) insufficient = `rollout_monitoring_insufficient:${language}`;
      measures.push({ measure, candidate, before, others, verdict });
    }
    languages.push({ language, measures });
  }
  return { languages, refusal: drop ?? insufficient };
}

/** The two windows of a rollout: [start, now) capped at max_window_days, and the equally long window before the start. */
export function rolloutWindows(createdAt: number, now: number, policy: RolloutPolicy): { current: [number, number]; baseline: [number, number] } {
  const length = Math.max(DAY_MS / 24, Math.min(now - createdAt, policy.max_window_days * DAY_MS));
  return { current: [now - length, now], baseline: [createdAt - length, createdAt] };
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface PromoteDeps {
  rpc: RpcClient;
  now?: () => number;
  /** The enabled languages; default: the configured languages, else the languages the candidate arm answered in. */
  languages?: () => readonly string[] | null;
  /** The job's judge cells for a window and tenants; default: none (judge score unmeasured). */
  readJudge?: (window: { since: string; until: string }, tenantKeys: readonly string[]) => Promise<LanguageJudgeCell[]>;
  /** The ended rollouts for the list; default: none. */
  readEnded?: () => Promise<EndedRollout[]>;
  activate?: Partial<RolloutActivators>;
  policy?: RolloutPolicy;
}

export interface RolloutActivators {
  embeddingProfile: (profileId: string, actor: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  chunkingProfile: (entry: { profileId: string; docType: string | null }, actor: string | null) => Promise<{ ok: true; docType: string; changed: boolean } | { ok: false; code: string }>;
  chunkingRollback: (docType: string, actor: string | null) => Promise<void>;
  rebuildRun: (runId: string, actor: string | null) => Promise<{ ok: true } | { ok: false; code: string }>;
}

export class RolloutRefusedError extends Error {
  constructor(readonly code: string) {
    super(`rollout_refused: ${code}`);
    this.name = 'RolloutRefusedError';
  }
}

export class RolloutUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RolloutUnavailableError';
  }
}

/** The refusal code of a failed rollout call: `rollout_refused: <code>` gives <code>; a malformed key bad_tenant_key. */
export function rolloutRefusalCode(message: string): string {
  const match = /rollout_refused: ([a-z_]+)/.exec(message) ?? /(rollout_failed): /.exec(message);
  if (match) return match[1]!;
  if (/tenant key/i.test(message)) return 'bad_tenant_key';
  return 'rpc_failed';
}

/** One rollout RPC; a SQL refusal throws RolloutRefusedError with its code, anything else RolloutUnavailableError. */
export async function rolloutRpc(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let response;
  try {
    response = await rpc.rpc(fn, args).abortSignal(new AbortController().signal);
  } catch {
    throw new RolloutUnavailableError('rpc_failed');
  }
  if (response.error) {
    const code = rolloutRefusalCode(response.error.message ?? '');
    if (code === 'rpc_failed') throw new RolloutUnavailableError(code);
    throw new RolloutRefusedError(code);
  }
  const rows = rpcRows(response.data);
  if (rows.length === 1 && rows[0] !== null && typeof rows[0] === 'object' && fn in (rows[0] as Record<string, unknown>)) {
    return (rows[0] as Record<string, unknown>)[fn];
  }
  return response.data;
}

export interface ActiveRolloutRow extends ActiveRollout {
  candidateRef: Record<string, unknown>;
  incumbentRef: Record<string, unknown> | null;
  createdAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export async function readActiveRollouts(rpc: RpcClient): Promise<ActiveRolloutRow[]> {
  const rows = rpcRows(await rolloutRpc(rpc, 'rag_rollout_active', {}));
  const out: ActiveRolloutRow[] = [];
  for (const raw of rows) {
    const parsed = parseActiveRollout(raw);
    const row = record(raw);
    if (!parsed || !row || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) continue;
    out.push({ ...parsed, candidateRef: record(row.candidate_ref) ?? {}, incumbentRef: record(row.incumbent_ref), createdAt: row.created_at });
  }
  return out;
}

/** The candidate of a ref as the ids the UI and the activation take. */
export function candidateIds(kind: RolloutKind, ref: Record<string, unknown> | null): string[] {
  if (!ref) return [];
  const value = kind === 'embedding_profile' ? ref.embedding_profile_id : kind === 'chunking_profile' ? ref.chunking_profile_ids : ref.rebuild_run_id;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return typeof value === 'string' ? [value] : [];
}

export interface RolloutArms {
  candidate: string[];
  incumbent: string[];
}

export interface RolloutObservation {
  arms: RolloutArms;
  comparison: RolloutComparison;
  windows: { current: { since: string; until: string }; baseline: { since: string; until: string } };
}

async function readCells(rpc: RpcClient, window: [number, number]): Promise<LanguageQualityCell[]> {
  const rows = rpcRows(
    await rolloutRpc(rpc, 'rag_language_quality_cells', {
      p_since: new Date(window[0]).toISOString(),
      p_until: new Date(window[1]).toISOString(),
      p_tenant_keys: null,
      p_min_confidence: null,
    }),
  ) as LanguageQualityCellRow[];
  return toLanguageQualityCells(rows, { since: day(window[0]), until: day(window[1]) });
}

/**
 * Reads both windows of every tenant through rag_language_quality_cells and splits them by arm on the server (the salt stays here):
 * a share rollout's candidate workspaces are known only by their bucket, so the cells are read for every tenant, never filtered by a
 * client-supplied list.
 */
export async function observeRollout(rollout: ActiveRolloutRow, deps: PromoteDeps): Promise<RolloutObservation> {
  const policy = deps.policy ?? rolloutPolicy();
  const now = (deps.now ?? Date.now)();
  const windows = rolloutWindows(Date.parse(rollout.createdAt), now, policy);
  const [currentCells, baselineCells] = [await readCells(deps.rpc, windows.current), await readCells(deps.rpc, windows.baseline)];
  const tenants = new Set<string>([...rollout.included, ...rollout.excluded]);
  for (const cell of [...currentCells, ...baselineCells]) if (cell.tenant_key) tenants.add(cell.tenant_key);
  const arms: RolloutArms = { candidate: [], incumbent: [] };
  for (const key of [...tenants].sort()) (inCandidateArm(rollout, key) ? arms.candidate : arms.incumbent).push(key);
  const candidate = new Set(arms.candidate);
  const isCandidate = (cell: { tenant_key: string | null }) => cell.tenant_key !== null && candidate.has(cell.tenant_key);
  const cells: RolloutArmCells = {
    candidateNow: currentCells.filter(isCandidate),
    candidateBefore: baselineCells.filter(isCandidate),
    othersNow: currentCells.filter((cell) => !isCandidate(cell)),
  };
  const dayWindows = {
    current: { since: day(windows.current[0]), until: day(windows.current[1]) },
    baseline: { since: day(windows.baseline[0]), until: day(windows.baseline[1]) },
  };
  let judge: RolloutJudgeCells | null = null;
  if (deps.readJudge && arms.candidate.length > 0) {
    const [now_, before, others] = [
      await deps.readJudge(dayWindows.current, arms.candidate),
      await deps.readJudge(dayWindows.baseline, arms.candidate),
      arms.incumbent.length > 0 ? await deps.readJudge(dayWindows.current, arms.incumbent) : [],
    ];
    if ([...now_, ...before, ...others].some((cell) => cell.judged > 0)) judge = { candidateNow: now_, candidateBefore: before, othersNow: others };
  }
  const configured = deps.languages?.() ?? null;
  const languages = configured && configured.length > 0 ? configured : [...new Set(cells.candidateNow.map((cell) => cell.language))];
  return { arms, comparison: compareRolloutLanguages({ languages, cells, judge, policy }), windows: dayWindows };
}

export type RolloutPromoteResult =
  | {
      ok: true;
      rolloutId: string;
      kind: RolloutKind;
      candidate: string[];
      arms: { candidate: number; incumbent: number };
      languages: RolloutLanguageRow[];
    }
  | { ok: false; code: string; languages?: RolloutLanguageRow[] };

function chunkingEntry(entry: string): { profileId: string; docType: string | null } {
  const at = entry.lastIndexOf(':');
  return at > 0 ? { docType: entry.slice(0, at), profileId: entry.slice(at + 1) } : { docType: null, profileId: entry };
}

const ACTIVATOR_KEYS: ReadonlyArray<keyof RolloutActivators> = ['embeddingProfile', 'chunkingProfile', 'chunkingRollback', 'rebuildRun'];

async function defaultActivators(): Promise<RolloutActivators> {
  const [embeddings, chunking, rebuild] = await Promise.all([
    import('../embeddings/profile-ops'),
    import('../chunking/profile-ops'),
    import('../ingest/rebuild/run'),
  ]);
  return {
    embeddingProfile: async (profileId, actor) => {
      const result = await embeddings.activateEmbeddingProfile(profileId, actor);
      if (result.ok) return { ok: true };
      return { ok: false, code: result.code === 'external_not_ready' && result.backend ? `external_not_ready:${result.backend}` : result.reason };
    },
    chunkingProfile: async (entry, actor) => {
      try {
        const done = await chunking.activateChunkingProfile(entry.profileId, { ...(entry.docType ? { docType: entry.docType } : {}), actor });
        return { ok: true, docType: done.docType, changed: done.changed };
      } catch (error) {
        if (error instanceof chunking.ChunkingActivationRefused) return { ok: false, code: error.reason };
        throw error;
      }
    },
    chunkingRollback: async (docType, actor) => {
      await chunking.rollbackChunkingProfile(docType, { actor });
    },
    rebuildRun: async (runId, actor) => {
      try {
        await rebuild.activateRebuild(runId, actor);
        return { ok: true };
      } catch (error) {
        if (error instanceof rebuild.RebuildRefused) return { ok: false, code: `${error.code}:${error.reason}` };
        if (error instanceof rebuild.RebuildNotFound) return { ok: false, code: 'run_not_found' };
        throw error;
      }
    },
  };
}

/** Runs the activation path of the rollout's kind; every refusal is returned unchanged. A refused chunking set is undone. */
async function activate(rollout: ActiveRolloutRow, actor: string | null, activators: RolloutActivators): Promise<{ ok: true } | { ok: false; code: string }> {
  const ids = candidateIds(rollout.kind, rollout.candidateRef);
  if (ids.length === 0) return { ok: false, code: 'bad_ref' };
  if (rollout.kind === 'embedding_profile') return activators.embeddingProfile(ids[0]!, actor ?? 'rollout');
  if (rollout.kind === 'rebuild_run') return activators.rebuildRun(ids[0]!, actor);
  const changed: string[] = [];
  for (const id of ids) {
    const result = await activators.chunkingProfile(chunkingEntry(id), actor);
    if (!result.ok) {
      for (const docType of changed.reverse()) await activators.chunkingRollback(docType, actor);
      return result;
    }
    if (result.changed) changed.push(result.docType);
  }
  return { ok: true };
}

/**
 * `promote <id>`: refuses, changing nothing, with rollout_not_active, rollout_observation_too_short,
 * rollout_language_drop:<lang>:<metric>, rollout_monitoring_insufficient:<lang>, or the activation path's own refusal (for example
 * external_not_ready:<backend>); otherwise activates the candidate for everyone and finishes the rollout as promoted.
 */
export async function promoteRollout(rolloutId: string, actor: string | null, deps: PromoteDeps): Promise<RolloutPromoteResult> {
  const policy = deps.policy ?? rolloutPolicy();
  const now = (deps.now ?? Date.now)();
  const rollout = (await readActiveRollouts(deps.rpc)).find((entry) => entry.id === rolloutId);
  if (!rollout) return { ok: false, code: 'rollout_not_active' };
  if (now - Date.parse(rollout.createdAt) < policy.observation_days * DAY_MS) return { ok: false, code: 'rollout_observation_too_short' };
  const observation = await observeRollout(rollout, { ...deps, policy, now: () => now });
  if (observation.comparison.refusal) return { ok: false, code: observation.comparison.refusal, languages: observation.comparison.languages };
  const given: Partial<RolloutActivators> = deps.activate ?? {};
  const complete = ACTIVATOR_KEYS.every((key) => typeof given[key] === 'function');
  const activators = { ...(complete ? {} : await defaultActivators()), ...given } as RolloutActivators;
  const activated = await activate(rollout, actor, activators);
  if (!activated.ok) return { ok: false, code: activated.code, languages: observation.comparison.languages };
  await rolloutRpc(deps.rpc, 'rag_rollout_finish', { p_rollout_id: rollout.id, p_state: 'promoted', p_actor: actor });
  console.log('[RAG Rollout] promoted', { rolloutId: rollout.id, kind: rollout.kind, languages: observation.comparison.languages.length });
  return {
    ok: true,
    rolloutId: rollout.id,
    kind: rollout.kind,
    candidate: candidateIds(rollout.kind, rollout.candidateRef),
    arms: { candidate: observation.arms.candidate.length, incumbent: observation.arms.incumbent.length },
    languages: observation.comparison.languages,
  };
}

export interface EndedRollout {
  id: string;
  kind: RolloutKind;
  candidate: string[];
  state: 'promoted' | 'rolled_back' | 'cancelled';
  endedAt: string;
}

export interface ActiveRolloutListEntry {
  id: string;
  kind: RolloutKind;
  candidate: string[];
  incumbent: string[];
  mode: 'tenants' | 'share';
  share: number | null;
  state: 'active';
  createdAt: string;
  included: string[];
  excluded: string[];
  arms: { candidate: number; incumbent: number };
  languages: RolloutLanguageRow[];
}

export interface RolloutList {
  active: ActiveRolloutListEntry[];
  ended: EndedRollout[];
  policy: { observationDays: number; minSamples: number };
}

/** The admin list: named fields only (never the salt or an actor id). */
export async function listRollouts(deps: PromoteDeps): Promise<RolloutList> {
  const policy = deps.policy ?? rolloutPolicy();
  const active: ActiveRolloutListEntry[] = [];
  for (const rollout of await readActiveRollouts(deps.rpc)) {
    const observation = await observeRollout(rollout, { ...deps, policy });
    active.push({
      id: rollout.id,
      kind: rollout.kind,
      candidate: candidateIds(rollout.kind, rollout.candidateRef),
      incumbent: candidateIds(rollout.kind, rollout.incumbentRef),
      mode: rollout.mode,
      share: rollout.sharePercent,
      state: 'active',
      createdAt: rollout.createdAt,
      included: [...rollout.included],
      excluded: [...rollout.excluded],
      arms: { candidate: observation.arms.candidate.length, incumbent: observation.arms.incumbent.length },
      languages: observation.comparison.languages,
    });
  }
  const ended = deps.readEnded ? await deps.readEnded() : [];
  return { active, ended, policy: { observationDays: policy.observation_days, minSamples: policy.min_samples } };
}

const ENDED_STATES = new Set(['promoted', 'rolled_back', 'cancelled']);
const KINDS = new Set(['embedding_profile', 'chunking_profile', 'rebuild_run']);

/** Ended rows of rag_rollouts (id, kind, candidate, state, ended_at), newest first; malformed rows are dropped. */
export function parseEndedRollouts(rows: unknown): EndedRollout[] {
  if (!Array.isArray(rows)) return [];
  const out: EndedRollout[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row || typeof row.id !== 'string' || typeof row.kind !== 'string' || !KINDS.has(row.kind)) continue;
    if (typeof row.state !== 'string' || !ENDED_STATES.has(row.state) || typeof row.ended_at !== 'string') continue;
    out.push({
      id: row.id,
      kind: row.kind as RolloutKind,
      candidate: candidateIds(row.kind as RolloutKind, record(row.candidate_ref)),
      state: row.state as EndedRollout['state'],
      endedAt: row.ended_at,
    });
  }
  return out;
}
