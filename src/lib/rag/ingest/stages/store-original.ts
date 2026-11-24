import type { StageContext, StageOutcome, StageSpec } from '../types';

/** No object store exists yet (plan 03-17 adds it), so the original is not kept and a resume cannot reread it. */
async function run(ctx: StageContext): Promise<StageOutcome> {
  ctx.warnings.push('no_object_store');
  return { kind: 'next', disabled: true, fallbackReason: 'no_object_store' };
}

export const storeOriginalStage: StageSpec = { name: 'store_original', minMsNeeded: 0, run };
