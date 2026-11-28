import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadRunConfig } from '../eval/harness/run-config.mts';
import { CALC_LIVE_RUN_CONFIGS, calcGoldenLines, calcLiveConfigProblem } from '../eval/harness/calc-nightly.mts';

const REPO_ROOT = process.cwd();
const RUNS = path.join(REPO_ROOT, 'eval/config/runs');

describe('nightly live calculation measurement (05.2.1-23, D-78)', () => {
  test('the golden subset is exactly the multi_step_calc items', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8');
    const lines = calcGoldenLines(text);
    const all = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { category: string });
    expect(lines.length).toBe(all.filter((item) => item.category === 'multi_step_calc').length);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => (JSON.parse(line) as { category: string }).category === 'multi_step_calc')).toBe(true);
  });

  test('the tool-off and tool-on configs keep the check on and answer with the live generator', () => {
    const off = loadRunConfig(path.join(RUNS, 'calc-live-tool-off.json'));
    const on = loadRunConfig(path.join(RUNS, 'calc-live-tool-on.json'));
    expect(off.env).toEqual({ RAG_CALC_CHECK: 'true', RAG_CALC_TOOL: 'false' });
    expect(on.env).toEqual({ RAG_CALC_CHECK: 'true', RAG_CALC_TOOL: 'true' });
    for (const [name, config] of [['calc-live-tool-off', off], ['calc-live-tool-on', on]] as const) {
      expect(config.name).toBe(name);
      expect(config.generatorModel).toBeUndefined();
      expect(calcLiveConfigProblem(path.join(RUNS, `${name}.json`), config)).toBeNull();
    }
    expect(CALC_LIVE_RUN_CONFIGS).toEqual(['calc-live-tool-off', 'calc-live-tool-on']);
  });

  test('a fake-generator or other run config is refused', () => {
    const follow = path.join(RUNS, 'calc-tool-follow.json');
    expect(calcLiveConfigProblem(follow, loadRunConfig(follow))).toMatch(/--calc-live takes/);
    const on = loadRunConfig(path.join(RUNS, 'calc-live-tool-on.json'));
    expect(calcLiveConfigProblem(path.join(RUNS, 'calc-live-tool-on.json'), { ...on, generatorModel: 'fake/calc-follow-v1' })).toMatch(
      /must not name a generator_model/,
    );
  });
});
