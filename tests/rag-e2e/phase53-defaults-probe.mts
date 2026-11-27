import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from '../../eval/harness/run-eval.mts';

/**
 * D-57 (plan 05.3-48): runs the committed fixture golden set in process (prechunked, single-tenant, fake citation generator, so
 * every item is answered) and writes one JSON document to the path given as its argument: per item the ranked chunk ids with their scores, the refusal decision and
 * the sha256 of the answer text (byte equality without copying fixture text into the reference). The defaults-equal test runs it
 * in a child process with every Phase 5.3 switch unset and compares the output with
 * tests/rag-e2e/defaults-equal-phase53.reference.json. Ids, scores and hashes only.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface ProbeCandidate {
  chunk_id: string;
  final_score: number | null;
  similarity: number | null;
}

export interface ProbeItem {
  item_id: string;
  refused: boolean | null;
  refusal_reason: string | null;
  answer_sha256: string | null;
  candidates: ProbeCandidate[];
}

interface TraceLine {
  item_id: string;
  refused?: boolean | null;
  refusal_reason?: string | null;
  answer?: string | null;
  candidates?: Array<{ chunk_id: string; final_score?: number | null; similarity?: number | null; rank?: number }>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function probeItems(tracesPath: string): ProbeItem[] {
  const items: ProbeItem[] = [];
  for (const line of fs.readFileSync(tracesPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const trace = JSON.parse(line) as TraceLine;
    const candidates = [...(trace.candidates ?? [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    items.push({
      item_id: trace.item_id,
      refused: typeof trace.refused === 'boolean' ? trace.refused : null,
      refusal_reason: typeof trace.refusal_reason === 'string' ? trace.refusal_reason : null,
      answer_sha256: typeof trace.answer === 'string' ? crypto.createHash('sha256').update(trace.answer, 'utf8').digest('hex') : null,
      candidates: candidates.map((candidate) => ({
        chunk_id: candidate.chunk_id,
        final_score: numberOrNull(candidate.final_score),
        similarity: numberOrNull(candidate.similarity),
      })),
    });
  }
  return items.sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
}

export async function runProbe(outDir: string): Promise<ProbeItem[]> {
  await runEval({
    goldenPath: path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'),
    corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus'),
    outDir,
    deploymentMode: 'single-tenant',
    fixtureMode: 'prechunked',
    tier: 'smoke',
    citations: true,
  });
  return probeItems(path.join(outDir, 'traces.jsonl'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error('[Defaults Probe] usage: phase53-defaults-probe.mts <output.json>');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase53-defaults-'));
  try {
    const items = await runProbe(outDir);
    fs.writeFileSync(target, `${JSON.stringify({ items })}\n`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
