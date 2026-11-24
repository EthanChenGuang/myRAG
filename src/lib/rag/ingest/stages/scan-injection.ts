import type { StageContext, StageOutcome, StageSpec } from '../types';

/**
 * The scanner arrives with plan 03-20. Until then, a deployment that asks for quarantine must not
 * publish unscanned text, so the run fails closed; with the scan off nothing changes.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  if (ctx.config.injectionScan === 'off') return { kind: 'next', disabled: true, outcome: 'scan_off' };
  return { kind: 'fail', reason: 'injection_scan_unavailable' };
}

export const scanInjectionStage: StageSpec = { name: 'scan_injection', minMsNeeded: 0, run };
