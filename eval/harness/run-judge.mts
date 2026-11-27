import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  judgeClaims,
  judgeClaimsForCalibration,
  setClaimJudgeForTests,
  type JudgeClaimsResult,
} from '../../src/lib/rag/generation/judge.ts';
import { FAKE_JUDGE_MODEL, fakeJudgeClaims } from './fake-answer-models.mts';

/**
 * Harness-only (D-27): runs the in-app claim judge over the labelled answers of eval/fixtures/judge/labelled-answers.jsonl and writes
 * one JSONL line per answer with its per-sentence verdicts, the judge model and judge_version, for
 * `python -m rag_eval.calibrate groundedness-judge`. `--judge fake` installs the deterministic fake judge; any other value (default
 * RAG_GROUNDEDNESS_JUDGE_MODEL) calls the real judge through judgeClaims, with the family gate against `--generator-model`.
 * Exit 2 on a usage error or a malformed input line. Never imported by src/.
 */

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REF_RE = /^S[1-9][0-9]*$/;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface LabelledSentence {
  index: number;
  text: string;
  premise_refs: string[];
  label: 'supported' | 'unsupported';
}

export interface LabelledAnswer {
  id: string;
  language: string;
  split: 'dev' | 'test';
  premises: Array<{ ref: string; text: string }>;
  sentences: LabelledSentence[];
}

export class LabelledLineError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Strict reading of one labelled line: unknown keys, a missing field, a repeated index or ref, or a bad label are errors. */
export function parseLabelledLine(line: string, lineNumber: number): LabelledAnswer {
  const fail = (what: string): never => {
    throw new LabelledLineError(`line ${lineNumber}: ${what}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail('not JSON');
  }
  if (!isRecord(raw)) return fail('not an object');
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'id,language,premises,sentences,split') return fail(`unexpected keys ${keys}`);
  const { id, language, split, premises, sentences } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('bad id');
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) fail('bad language');
  if (split !== 'dev' && split !== 'test') fail('split must be dev or test');
  if (!Array.isArray(premises) || premises.length === 0) return fail('premises must be a non-empty list');
  if (!Array.isArray(sentences) || sentences.length === 0) return fail('sentences must be a non-empty list');
  const refs = new Set<string>();
  for (const premise of premises) {
    if (!isRecord(premise) || typeof premise.ref !== 'string' || !REF_RE.test(premise.ref) || !nonEmpty(premise.text)) fail('bad premise');
    if (refs.has((premise as { ref: string }).ref)) fail('repeated premise ref');
    refs.add((premise as { ref: string }).ref);
  }
  const indexes = new Set<number>();
  for (const sentence of sentences) {
    if (!isRecord(sentence)) return fail('bad sentence');
    const { index, text, premise_refs: sentenceRefs, label } = sentence;
    if (!Number.isInteger(index) || (index as number) < 0 || indexes.has(index as number)) fail('bad or repeated sentence index');
    indexes.add(index as number);
    if (!nonEmpty(text)) fail('blank sentence');
    if (!Array.isArray(sentenceRefs) || sentenceRefs.length === 0 || !sentenceRefs.every((ref) => typeof ref === 'string' && REF_RE.test(ref))) {
      fail('bad premise_refs');
    }
    if (label !== 'supported' && label !== 'unsupported') fail('label must be supported or unsupported');
  }
  return raw as unknown as LabelledAnswer;
}

export function readLabelled(file: string): LabelledAnswer[] {
  const answers: LabelledAnswer[] = [];
  const ids = new Set<string>();
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, offset) => {
      if (!line.trim()) return;
      const answer = parseLabelledLine(line, offset + 1);
      if (ids.has(answer.id)) throw new LabelledLineError(`line ${offset + 1}: repeated id ${answer.id}`);
      ids.add(answer.id);
      answers.push(answer);
    });
  if (answers.length === 0) throw new LabelledLineError('the labelled file holds no answer');
  return answers;
}

export interface JudgeRunLine {
  id: string;
  language: string;
  split: 'dev' | 'test';
  status: JudgeClaimsResult['status'];
  reason: string | null;
  judge_model: string | null;
  judge_version: string | null;
  verdicts: Array<{ index: number; verdict: 'supported' | 'unsupported' | 'not_enough_info' }>;
}

function inputsOf(answer: LabelledAnswer) {
  return {
    language: answer.language,
    premises: answer.premises.map((premise) => ({ ref: premise.ref, text: premise.text })),
    claims: answer.sentences.map((sentence) => ({ index: sentence.index, hypothesis: sentence.text, premise_refs: [...sentence.premise_refs] })),
  };
}

/** One line per answer; the fake judge is installed for the run and removed afterwards. */
export async function runJudgeOverLabelled(
  answers: readonly LabelledAnswer[],
  options: { judge: string; generatorModel?: string },
): Promise<JudgeRunLine[]> {
  const fake = options.judge === 'fake';
  const lines: JudgeRunLine[] = [];
  try {
    for (const answer of answers) {
      const input = inputsOf(answer);
      let result: JudgeClaimsResult;
      if (fake) {
        // The fake judges the structured premises and claims of this answer; the prompt the real judge reads is still built.
        setClaimJudgeForTests(async () => ({ object: fakeJudgeClaims(input) }));
        result = await judgeClaimsForCalibration({ ...input, judgeModel: FAKE_JUDGE_MODEL });
      } else {
        result = await judgeClaims({ ...input, judgeModel: options.judge, generatorModelId: options.generatorModel ?? '' });
      }
      lines.push({
        id: answer.id,
        language: answer.language,
        split: answer.split,
        status: result.status,
        reason: result.status === 'judged' ? null : result.reason,
        judge_model: result.judgeModel,
        judge_version: result.judgeVersion,
        verdicts: result.status === 'judged' ? result.verdicts.map((verdict) => ({ index: verdict.index, verdict: verdict.verdict })) : [],
      });
    }
  } finally {
    if (fake) setClaimJudgeForTests(null);
  }
  return lines;
}

async function main(): Promise<number> {
  let values: { labelled?: string; out?: string; judge?: string; 'generator-model'?: string };
  try {
    ({ values } = parseArgs({
      options: {
        labelled: { type: 'string' },
        out: { type: 'string' },
        judge: { type: 'string' },
        'generator-model': { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`[Run Judge] ${error instanceof Error ? error.message : 'bad arguments'}`);
    return 2;
  }
  if (!values.labelled || !values.out) {
    console.error('[Run Judge] --labelled and --out are required');
    return 2;
  }
  const judge = (values.judge ?? process.env.RAG_GROUNDEDNESS_JUDGE_MODEL ?? '').trim();
  if (!judge) {
    console.error('[Run Judge] no judge: pass --judge fake, --judge <model id> or set RAG_GROUNDEDNESS_JUDGE_MODEL');
    return 2;
  }
  if (judge !== 'fake' && !values['generator-model']?.trim()) {
    console.error('[Run Judge] a real judge needs --generator-model (the D-25 family rule)');
    return 2;
  }
  let answers: LabelledAnswer[];
  try {
    answers = readLabelled(path.resolve(values.labelled));
  } catch (error) {
    if (error instanceof LabelledLineError) {
      console.error(`[Run Judge] malformed labelled input: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const lines = await runJudgeOverLabelled(answers, { judge, generatorModel: values['generator-model']?.trim() });
  const out = path.resolve(values.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const judged = lines.filter((line) => line.status === 'judged').length;
  console.log(`[Run Judge] ${lines.length} answer(s), ${judged} judged, written to ${out}`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error('[Run Judge] failed', error instanceof Error ? error.name : typeof error);
      process.exit(1);
    },
  );
}
