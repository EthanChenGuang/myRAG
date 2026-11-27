import rawCalibration from '../../../../eval/config/judge-calibration.json';
import rawGates from '../../../../eval/config/quality-gates.json';
import { JudgeCalibrationSchema, QualityGatesSchema, type JudgeCalibration } from '@/lib/rag-eval/contracts.generated';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';

/**
 * Which model judges count, for the Config UI (D-29, UI-SPEC 6.9 and 8.1). Read-only: the committed calibration file changes only
 * through the calibration tool and a pull request. A cell older than max_age_days, or whose fingerprint differs from the running
 * judge of its role (or whose role has no recorded running judge), is `uncalibrated`, which is report only. Numbers and codes only.
 */

type StoredCell = NonNullable<JudgeCalibration['cells']>[number];
type Role = StoredCell['role'];

export type JudgeCellStatus = 'gating' | 'report_only' | 'uncalibrated';
export type JudgeCellReason = NonNullable<StoredCell['reasons']>[number] | 'expired' | 'fingerprint_mismatch';

export interface JudgeFloors {
  kappa: number;
  accuracy: number;
  min_labels: number;
  seed_min_labels: number;
  max_age_days: number;
}

export interface JudgeCalibrationCellView {
  key: string;
  role: Role;
  language: StoredCell['language'];
  library: StoredCell['library'];
  metric: string;
  fingerprint: string;
  status: JudgeCellStatus;
  reasons: JudgeCellReason[];
  kappa: number | null;
  accuracy: number | null;
  n: number;
  source: StoredCell['source'];
  labels_human_confirmed: boolean;
  unsupported_recall: number | null;
  unsupported_precision: number | null;
  length_bias_delta: number | null;
  expanded_delta: number | null;
  assertive_delta: number | null;
  recorded_at: string;
  valid_until: string | null;
}

export type JudgeCalibrationWarning =
  | { code: 'none_enforced'; message: string }
  | { code: 'calibration_invalid'; message: string }
  | { code: 'expired_cells'; count: number; days: number; keys: string[]; message: string }
  | { code: 'judge_changed'; roles: Role[]; keys: string[]; message: string };

export interface JudgeCalibrationStatus {
  floors: JudgeFloors | null;
  running: Record<Role, string | null>;
  cells: JudgeCalibrationCellView[];
  warnings: JudgeCalibrationWarning[];
}

const ROLES: readonly Role[] = ['nightly', 'online'];
const DAY_MS = 86_400_000;

function floorsOf(gates: unknown): { floors: JudgeFloors; maxAgeDays: number } | null {
  const judge = QualityGatesSchema.shape.judge.safeParse((gates as { judge?: unknown } | null)?.judge);
  if (!judge.success) return null;
  const block = judge.data;
  return {
    floors: {
      kappa: block.kappa_floor,
      accuracy: block.accuracy_floor,
      min_labels: block.min_labels_per_language,
      seed_min_labels: block.seed_min_labels_per_language,
      max_age_days: block.max_age_days,
    },
    maxAgeDays: block.max_age_days,
  };
}

function recordedMs(recordedAt: string): number | null {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(recordedAt) ? `${recordedAt}T00:00:00Z` : recordedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Rows by role, then language in registry order (unknown codes last), then library and metric. */
function sortKey(cell: JudgeCalibrationCellView, languageOrder: readonly string[]): [number, number, string, string] {
  const language = languageOrder.indexOf(cell.language);
  return [ROLES.indexOf(cell.role), language < 0 ? languageOrder.length : language, cell.library, cell.metric];
}

function compare(a: JudgeCalibrationCellView, b: JudgeCalibrationCellView, languageOrder: readonly string[]): number {
  const [ra, la, liba, ma] = sortKey(a, languageOrder);
  const [rb, lb, libb, mb] = sortKey(b, languageOrder);
  return ra - rb || la - lb || liba.localeCompare(libb) || ma.localeCompare(mb);
}

/** Pure status of one calibration file under the quality-gates judge block on a given day. */
export function judgeCalibrationStatus(calibration: unknown, gates: unknown, today: Date): JudgeCalibrationStatus {
  const warnings: JudgeCalibrationWarning[] = [];
  const parsed = JudgeCalibrationSchema.safeParse(calibration);
  const floors = floorsOf(gates);
  const running: Record<Role, string | null> = { nightly: null, online: null };

  if (!parsed.success || !floors) {
    warnings.push({
      code: 'calibration_invalid',
      message: 'The committed judge calibration file or the judge block of quality-gates.json does not validate, so every judge is report only.',
    });
    warnings.push({ code: 'none_enforced', message: 'No judge is enforced: every judge score is report only.' });
    return { floors: floors?.floors ?? null, running, cells: [], warnings };
  }

  const fingerprints = parsed.data.running_fingerprints ?? {};
  for (const role of ROLES) running[role] = typeof fingerprints[role] === 'string' ? fingerprints[role] : null;

  const now = today.getTime();
  const expired: string[] = [];
  const changed: string[] = [];
  const changedRoles = new Set<Role>();

  const cells = (parsed.data.cells ?? []).map((cell): JudgeCalibrationCellView => {
    const recorded = recordedMs(cell.recorded_at);
    const validUntilMs = recorded === null ? null : recorded + floors.maxAgeDays * DAY_MS;
    const reasons: JudgeCellReason[] = [...(cell.reasons ?? [])];
    let status: JudgeCellStatus = cell.status;
    if (validUntilMs === null || now > validUntilMs) {
      status = 'uncalibrated';
      reasons.push('expired');
      expired.push(cell.key);
    }
    if (running[cell.role] !== cell.fingerprint) {
      status = 'uncalibrated';
      reasons.push('fingerprint_mismatch');
      changed.push(cell.key);
      changedRoles.add(cell.role);
    }
    return {
      key: cell.key,
      role: cell.role,
      language: cell.language,
      library: cell.library,
      metric: cell.metric,
      fingerprint: cell.fingerprint,
      status,
      reasons,
      kappa: cell.kappa ?? null,
      accuracy: cell.accuracy ?? null,
      n: cell.n,
      source: cell.source,
      labels_human_confirmed: cell.labels_human_confirmed,
      unsupported_recall: cell.unsupported_recall ?? null,
      unsupported_precision: cell.unsupported_precision ?? null,
      length_bias_delta: cell.length_bias_delta ?? null,
      expanded_delta: cell.expanded_delta ?? null,
      assertive_delta: cell.assertive_delta ?? null,
      recorded_at: cell.recorded_at,
      valid_until: validUntilMs === null ? null : new Date(validUntilMs).toISOString().slice(0, 10),
    };
  });
  const languageOrder = getLanguageRegistry().packs.map((pack) => pack.code);
  cells.sort((a, b) => compare(a, b, languageOrder));

  if (!cells.some((cell) => cell.status === 'gating')) {
    warnings.push({ code: 'none_enforced', message: 'No judge is enforced: every judge score is report only, and no limit depends on a judge.' });
  }
  if (expired.length > 0) {
    warnings.push({
      code: 'expired_cells',
      count: expired.length,
      days: floors.maxAgeDays,
      keys: expired,
      message: `Calibrations older than ${floors.maxAgeDays} days: ${expired.length}. They are report only until the calibration runs again.`,
    });
  }
  if (changed.length > 0) {
    warnings.push({
      code: 'judge_changed',
      roles: ROLES.filter((role) => changedRoles.has(role)),
      keys: changed,
      message: 'The judge model, prompt or rubric changed since the last calibration, so its rows are report only.',
    });
  }

  return { floors: floors.floors, running, cells, warnings };
}

/** The status of the committed calibration file (static import) under the committed quality gates, today. */
export function currentJudgeCalibrationStatus(today: Date = new Date()): JudgeCalibrationStatus {
  return judgeCalibrationStatus(rawCalibration, rawGates, today);
}
