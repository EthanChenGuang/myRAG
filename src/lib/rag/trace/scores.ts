import type { LangfuseConfig } from './config';

export type LangfuseScoreDataType = 'NUMERIC' | 'CATEGORICAL' | 'BOOLEAN';

export interface LangfuseScoreInput {
  traceId: string;
  name: string;
  value: number | string;
  dataType: LangfuseScoreDataType;
  comment?: string;
  metadata?: Record<string, unknown>;
}

export type PostScoresStatus = 'accepted' | 'partial' | 'failed' | 'skipped';

export interface PostScoresResult {
  status: PostScoresStatus;
  httpStatus: number | null;
}

export interface PostScoresOptions {
  config?: LangfuseConfig;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function scoreId(_traceId: string, _name: string): string {
  return '';
}

export async function postLangfuseScores(_scores: readonly LangfuseScoreInput[], _options: PostScoresOptions = {}): Promise<PostScoresResult> {
  return { status: 'skipped', httpStatus: null };
}
