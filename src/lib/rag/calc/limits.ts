/**
 * Evaluator bounds as data (D-69, RESEARCH Pitfall C3): config/rag/calc-limits.json, validated with the generated
 * CalcLimits schema at import. An invalid file is a configuration error and throws; it is never a request error.
 */
import { createHash } from 'node:crypto';
import { CalcLimitsSchema, type CalcLimits } from '@/lib/rag-eval/contracts.generated';
import { canonicalJson } from '@/lib/rag-eval/trace';
import rawLimits from '../../../../config/rag/calc-limits.json';

export type { CalcLimits };

/** Validates a limits object; throws with the schema issues when it does not match. */
export function parseCalcLimits(raw: unknown): CalcLimits {
  const parsed = CalcLimitsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`[Calc] config/rag/calc-limits.json is invalid: ${issues}`);
  }
  return Object.freeze({ ...parsed.data });
}

const LIMITS: CalcLimits = parseCalcLimits(rawLimits);
const VERSION: string = createHash('sha256').update(canonicalJson(rawLimits), 'utf8').digest('hex');

export function calcLimits(): CalcLimits {
  return LIMITS;
}

/** SHA-256 of the canonical limits file, for the retrieval config hash (plan 05.2.1-13). */
export function calcLimitsVersion(): string {
  return VERSION;
}
