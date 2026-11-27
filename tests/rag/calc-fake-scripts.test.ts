import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCalc } from '@/lib/rag/calc/evaluate';
import type { CalcRequest } from '@/lib/rag-eval/contracts.generated';

const SCRIPTS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../eval/fixtures/calc-fake-scripts.json'), 'utf8')) as {
  groups: Array<{ paraphrase_group: string; blocks: Record<string, unknown>; request: CalcRequest; expected_value: string; unit: string }>;
};

describe('calc fake scripts run through the shared evaluator (05.2.1-17, D-78)', () => {
  for (const group of SCRIPTS.groups) {
    it(`${group.paraphrase_group}: the scripted request evaluates to the expected value and unit`, () => {
      const result = evaluateCalc(group.request, { aliases: new Set(Object.keys(group.blocks)) });
      expect(result.reject_reason).toBeNull();
      expect(result.status).toBe('ok');
      expect(result.value).toBe(group.expected_value);
      expect(result.unit).toBe(group.unit);
    });
  }
});
