import { requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** Extractors the enrich stage already covers; the profile keeps them listed (D-14). */
const HANDLED_BY_ENRICH = new Set(['urls']);

/**
 * Runs the profile's extractors. None exist yet (plans 03-18 and 03-29 add them), so each listed one is
 * recorded as unavailable instead of silently skipped.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const { profile } = requireIdentity(ctx, 'extract');
  const missing = profile.extractors.filter((name) => !HANDLED_BY_ENRICH.has(name));
  for (const name of missing) ctx.warnings.push(`extractor_unavailable:${name}`);
  if (missing.length === 0) return { kind: 'next' };
  return { kind: 'next', disabled: true, fallbackReason: 'extractor_unavailable' };
}

export const extractStage: StageSpec = { name: 'extract', minMsNeeded: 0, run };
