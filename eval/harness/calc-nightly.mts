import path from 'node:path';
import type { RunConfig } from './run-config.mts';

/**
 * Plan 05.2.1-23 (D-78): the nightly live calculation measurement. The multi_step_calc items are answered by the live
 * generator under calc-live-tool-off (RAG_CALC_TOOL false, RAG_CALC_CHECK true) and calc-live-tool-on (both true), then
 * scored; numeric correctness is reported per language and not gated.
 */
export const CALC_CATEGORY = 'multi_step_calc';
export const CALC_LIVE_RUN_CONFIGS: readonly string[] = ['calc-live-tool-off', 'calc-live-tool-on'];

export function calcGoldenLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => (JSON.parse(line) as { category?: string }).category === CALC_CATEGORY);
}

/** A calc-live run config: one of the two names and no generator model of its own (the live generator answers). */
export function calcLiveConfigProblem(file: string, config: RunConfig): string | null {
  if (!CALC_LIVE_RUN_CONFIGS.includes(config.name) || path.basename(file) !== `${config.name}.json`) {
    return `--calc-live takes ${CALC_LIVE_RUN_CONFIGS.map((name) => `eval/config/runs/${name}.json`).join(' or ')}, got ${file}`;
  }
  if (config.generatorModel !== undefined) return `--calc-live answers with the live generator; ${config.name} must not name a generator_model`;
  return null;
}
