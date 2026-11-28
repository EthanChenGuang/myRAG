import { z } from 'zod/v3';
import rawReport from '../../../../eval/reports/chunking-sweep.json';
import rawDecisions from '../../../../eval/decisions/chunking/index.json';
import {
  ChunkingDecisionSchema,
  ChunkingSweepReportSchema,
  type ChunkingDecision,
  type ChunkingSweepReport,
} from '@/lib/rag-eval/contracts.generated';

export type ChunkingReportCode = 'chunking_report_invalid' | 'chunking_decisions_invalid';

/** A committed report or decisions index does not match its generated schema. Carries the code only. */
export class ChunkingReportInvalid extends Error {
  readonly code: ChunkingReportCode;

  constructor(code: ChunkingReportCode) {
    super(`[RAG Chunking] ${code}`);
    this.name = 'ChunkingReportInvalid';
    this.code = code;
  }
}

// Statically imported so the files ship in the server bundle; checked once at module load.
const report = ChunkingSweepReportSchema.safeParse(rawReport);
const decisions = z.array(ChunkingDecisionSchema).safeParse(rawDecisions);

/** The committed chunking sweep report (eval/reports/chunking-sweep.json), validated with the generated schema. */
export function getChunkingSweepReport(): ChunkingSweepReport {
  if (!report.success) throw new ChunkingReportInvalid('chunking_report_invalid');
  return report.data;
}

/** The recorded chunking decisions (eval/decisions/chunking/index.json), validated with the generated schema. */
export function getChunkingDecisions(): ChunkingDecision[] {
  if (!decisions.success) throw new ChunkingReportInvalid('chunking_decisions_invalid');
  return decisions.data;
}
