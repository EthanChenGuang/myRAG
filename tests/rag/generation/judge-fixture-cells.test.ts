import { afterEach, describe, expect, it } from 'vitest';
import rawJudgeThresholds from '../../../eval/config/groundedness-judge-thresholds.json';
import { judgeAnswerLabel, judgeClaimsForCalibration, judgeVersion, loadJudgeThresholds, setClaimJudgeForTests, type JudgeVerdict } from '@/lib/rag/generation/judge';
import { FAKE_JUDGE_MODEL, fakeJudgeClaims } from '../../../eval/harness/fake-answer-models.mts';

// D-27, ROADMAP 5.2 criterion 2 on fixtures: the committed cells written by `python -m rag_eval.calibrate groundedness-judge --judge fake`.

const NOW = new Date('2026-11-27T00:00:00.000Z');
const PREMISES = [
  { ref: 'S1', text: 'Il pannello K contiene 41 unità.' },
  { ref: 'S2', text: 'Il pannello M contiene 52 unità.' },
];

afterEach(() => setClaimJudgeForTests(null));

async function fakeJudge(claims: Array<{ index: number; hypothesis: string; premise_refs: string[] }>): Promise<JudgeVerdict[]> {
  setClaimJudgeForTests(async () => ({ object: fakeJudgeClaims({ premises: PREMISES, claims }) }));
  const result = await judgeClaimsForCalibration({ language: 'it', premises: PREMISES, claims, judgeModel: FAKE_JUDGE_MODEL });
  if (result.status !== 'judged') throw new Error(`fake judge not judged: ${result.reason}`);
  return result.verdicts;
}

describe('committed fake-judge fixture cells', () => {
  it('are keyed by the fake judge model, its judge_version and language, for zh, en and it', () => {
    const keys = rawJudgeThresholds.cells.map((cell) => [cell.judge_model, cell.judge_version, cell.language].join('|')).sort();
    const version = judgeVersion(FAKE_JUDGE_MODEL);
    expect(keys).toEqual([`${FAKE_JUDGE_MODEL}|${version}|en`, `${FAKE_JUDGE_MODEL}|${version}|it`, `${FAKE_JUDGE_MODEL}|${version}|zh`]);
  });

  it('give an Italian eval answer judged by the fake judge a calibrated label instead of not checked', async () => {
    const verdicts = await fakeJudge([
      { index: 0, hypothesis: 'Il pannello K contiene 41 unità.', premise_refs: ['S1'] },
      { index: 1, hypothesis: 'Il pannello M contiene 52 unità.', premise_refs: ['S2'] },
    ]);
    const base = { judgeModel: FAKE_JUDGE_MODEL, judgeVersion: judgeVersion(FAKE_JUDGE_MODEL), language: 'it', latencyMs: 3, now: () => NOW };
    const verified = judgeAnswerLabel({ ...base, judgements: verdicts, allowFixtureCells: true });
    expect(verified).toMatchObject({ status: 'scored', label: 'verified', scorer: 'llm_judge', thresholdSource: 'calibrated' });

    const flagged = await fakeJudge([
      { index: 0, hypothesis: 'Il pannello K contiene 41 unità.', premise_refs: ['S1'] },
      { index: 1, hypothesis: 'Il pannello K contiene 63 unità.', premise_refs: ['S1'] },
    ]);
    expect(judgeAnswerLabel({ ...base, judgements: flagged, allowFixtureCells: true })).toMatchObject({ status: 'scored', label: 'possibly_unreliable' });
  });

  it('never apply outside eval runs', async () => {
    const verdicts = await fakeJudge([{ index: 0, hypothesis: 'Il pannello K contiene 41 unità.', premise_refs: ['S1'] }]);
    const result = judgeAnswerLabel({ judgements: verdicts, judgeModel: FAKE_JUDGE_MODEL, judgeVersion: judgeVersion(FAKE_JUDGE_MODEL), language: 'it', latencyMs: 1 });
    expect(result).toMatchObject({ status: 'not_checked', reason: 'judge_uncalibrated' });
  });

  it('match no production judge model id', () => {
    const verdicts: JudgeVerdict[] = [{ index: 0, verdict: 'supported', evidenceRef: 'S1' }];
    for (const model of ['openai/gpt-4.1-mini', 'google/gemini-2.5-flash', 'anthropic/claude-sonnet-4']) {
      const result = judgeAnswerLabel({ judgements: verdicts, judgeModel: model, judgeVersion: judgeVersion(model), language: 'it', latencyMs: 1, allowFixtureCells: true });
      expect(result).toMatchObject({ status: 'not_checked', reason: 'judge_uncalibrated' });
    }
    expect([...loadJudgeThresholds().cells.keys()].every((key) => key.startsWith(`${FAKE_JUDGE_MODEL}\u0000`))).toBe(true);
  });

  it('judgeClaimsForCalibration skips only the family gate: an empty judge model is still not configured', async () => {
    const result = await judgeClaimsForCalibration({ language: 'it', premises: PREMISES, claims: [], judgeModel: ' ' });
    expect(result).toMatchObject({ status: 'not_checked', reason: 'judge_not_configured' });
  });
});
