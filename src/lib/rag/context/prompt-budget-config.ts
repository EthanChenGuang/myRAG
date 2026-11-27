/**
 * Phase 5.2.1 D-80, D-81: the prompt-budget parameters (config/rag/prompt-budget.json) and the per-family tokenizer factors
 * (eval/config/tokenizer-calibration.json, written only by the calibration tool), validated with the generated contracts at
 * import. An invalid file is a configuration error and throws. No provider tokenizer endpoint is called.
 */
import { createHash } from 'node:crypto';
import {
  PromptBudgetConfigSchema,
  TokenizerCalibrationSchema,
  type PromptBudgetConfig,
  type TokenizerCalibration,
} from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import { countContextTokens } from './budget';
import rawBudgetConfig from '../../../../config/rag/prompt-budget.json';
import rawCalibration from '../../../../eval/config/tokenizer-calibration.json';

export type { PromptBudgetConfig, TokenizerCalibration };
export type FactorSource = 'measured' | 'default';

function issuesOf(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function parsePromptBudgetConfig(raw: unknown): PromptBudgetConfig {
  const parsed = PromptBudgetConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`[Prompt Budget] config/rag/prompt-budget.json is invalid: ${issuesOf(parsed.error)}`);
  return Object.freeze({ ...parsed.data });
}

/** The generated schema carries the field rules only; the two Pydantic model validators are re-checked here. */
export function parseTokenizerCalibration(raw: unknown): TokenizerCalibration {
  const parsed = TokenizerCalibrationSchema.safeParse(raw);
  const fail = (detail: string): never => {
    throw new Error(`[Prompt Budget] eval/config/tokenizer-calibration.json is invalid: ${detail}`);
  };
  if (!parsed.success) return fail(issuesOf(parsed.error));
  const families = parsed.data.families ?? [];
  const names = new Set<string>();
  for (const cell of families) {
    if (names.has(cell.family)) fail('a family appears at most once');
    names.add(cell.family);
    if (cell.source === 'measured' && (cell.samples < 1 || !cell.run_ids || cell.run_ids.length === 0)) {
      fail('a measured factor needs samples and run_ids');
    }
  }
  return Object.freeze({ ...parsed.data, families: Object.freeze(families.map((cell) => Object.freeze({ ...cell }))) as TokenizerCalibration['families'] });
}

function versionOf(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw), 'utf8').digest('hex');
}

const CONFIG: PromptBudgetConfig = parsePromptBudgetConfig(rawBudgetConfig);
const CALIBRATION: TokenizerCalibration = parseTokenizerCalibration(rawCalibration);
const CONFIG_VERSION = versionOf(rawBudgetConfig);
const CALIBRATION_VERSION = versionOf(rawCalibration);

export function promptBudgetConfig(): PromptBudgetConfig {
  return CONFIG;
}

export function tokenizerCalibration(): TokenizerCalibration {
  return CALIBRATION;
}

/** SHA-256 of the canonical prompt-budget file, for the retrieval config hash. */
export function promptBudgetConfigVersion(): string {
  return CONFIG_VERSION;
}

/** SHA-256 of the canonical calibration file, for the retrieval config hash. */
export function tokenizerCalibrationVersion(): string {
  return CALIBRATION_VERSION;
}

/** The family's recorded factor, or the conservative default factor with source default. */
export function factorFor(
  family: string | null,
  calibration: TokenizerCalibration = CALIBRATION,
): { factor: number; source: FactorSource } {
  const cell = family === null ? undefined : (calibration.families ?? []).find((entry) => entry.family === family);
  if (cell) return { factor: cell.factor, source: cell.source };
  return { factor: calibration.default_factor, source: 'default' };
}

/** ceil(cl100k count times the family factor); the margin is added once per request by the planner. */
export function estimateTokens(text: string, family: string | null, calibration: TokenizerCalibration = CALIBRATION): number {
  if (!text) return 0;
  return Math.ceil(countContextTokens(text) * factorFor(family, calibration).factor);
}
