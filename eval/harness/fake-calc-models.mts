import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CalcRequest } from '../../src/lib/rag-eval/contracts.generated.ts';

/**
 * Harness-only scripted calculation models for the Phase 5.2.1 gates (D-78, RESEARCH Pattern C). Behaviour is data: each
 * fake finds its paraphrase group in eval/fixtures/calc-fake-scripts.json by the question text, maps the script's block
 * alias to the context block that holds the quoted rule, and reads only the prompt it receives. A fake calls the tool, or
 * writes the trailing block, only when the `[rule:calculation]` part is in its system prompt; without it the answer is plain
 * text that applies the rule to the total. Selected by model id through installFakeAnswerModels; never imported by src/.
 */
export const FAKE_CALC_FOLLOW_MODEL = 'fake/calc-follow-v1';
export const FAKE_CALC_FOLLOW_BLOCK_MODEL = 'fake/calc-follow-block-v1';
export const FAKE_CALC_SKIP_RULE_MODEL = 'fake/calc-skip-rule-v1';
export const FAKE_CALC_MISSING_OPERAND_MODEL = 'fake/calc-missing-operand-v1';

export const FAKE_CALC_MODEL_IDS = [
  FAKE_CALC_FOLLOW_MODEL,
  FAKE_CALC_FOLLOW_BLOCK_MODEL,
  FAKE_CALC_SKIP_RULE_MODEL,
  FAKE_CALC_MISSING_OPERAND_MODEL,
] as const;

export type FakeCalcModelId = (typeof FAKE_CALC_MODEL_IDS)[number];

/** The fake that declares no tool support, so the eval turn offers the trailing block instead (D-72). */
const NO_TOOL_MODELS: ReadonlySet<string> = new Set([FAKE_CALC_FOLLOW_BLOCK_MODEL]);

export const CALC_FAKE_SCRIPTS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/calc-fake-scripts.json');


export interface CalcScriptBlock {
  document: string;
  quote: string;
  section: string;
}

export interface CalcScriptGroup {
  paraphrase_group: string;
  language: string;
  rule_shape: string;
  items: string[];
  questions: string[];
  blocks: Record<string, CalcScriptBlock>;
  request: CalcRequest;
  expected_value: string;
  unit: string;
  skip_rule: { stated_value: string; how: string };
  missing_operand: { operand: string; cited_value: string };
}

export interface CalcFakeScripts {
  schema_version: number;
  groups: CalcScriptGroup[];
}

export function isFakeCalcModel(modelId: string): modelId is FakeCalcModelId {
  return (FAKE_CALC_MODEL_IDS as readonly string[]).includes(modelId);
}

/** The fake registry's tool capability: false for a fake that declares no tool support, undefined for any other id. */
export function fakeCalcToolCapability(modelId: string): boolean | undefined {
  return NO_TOOL_MODELS.has(modelId) ? false : undefined;
}

let cachedScripts: CalcFakeScripts | null = null;

export function loadCalcFakeScripts(file: string = CALC_FAKE_SCRIPTS_PATH): CalcFakeScripts {
  if (file === CALC_FAKE_SCRIPTS_PATH && cachedScripts) return cachedScripts;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CalcFakeScripts;
  if (!Array.isArray(parsed.groups)) throw new Error(`[Fake Calc] ${file} has no groups`);
  if (file === CALC_FAKE_SCRIPTS_PATH) cachedScripts = parsed;
  return parsed;
}

