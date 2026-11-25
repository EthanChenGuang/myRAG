import { createHash } from 'node:crypto';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from './config';

const SCORES_PATH = '/api/public/scores';
const DEFAULT_TIMEOUT_MS = 3000;

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

/** sha256 of "traceId|name": posting the same score name on a trace again overwrites it (research Pattern 8). */
export function scoreId(traceId: string, name: string): string {
  return createHash('sha256').update(`${traceId}|${name}`).digest('hex');
}

/** Time-boxed batch POST to Langfuse's scores endpoint, mirroring eval/src/rag_eval/langfuse_api.py. 202 is accepted, 207 partial. Never throws. */
export async function postLangfuseScores(scores: readonly LangfuseScoreInput[], options: PostScoresOptions = {}): Promise<PostScoresResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = options.config ?? readLangfuseConfig();
    if (!isLangfuseUsable(config) || scores.length === 0) return { status: 'skipped', httpStatus: null };
    const body = scores.map((score) => ({
      id: scoreId(score.traceId, score.name),
      traceId: score.traceId,
      name: score.name,
      value: score.value,
      dataType: score.dataType,
      ...(score.comment !== undefined ? { comment: score.comment } : {}),
      ...(score.metadata !== undefined ? { metadata: score.metadata } : {}),
    }));
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const token = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');
    const response = await (options.fetch ?? fetch)(`${config.baseUrl}${SCORES_PATH}`, {
      method: 'POST',
      headers: { authorization: `Basic ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 202 || response.status === 200) return { status: 'accepted', httpStatus: response.status };
    if (response.status === 207) return { status: 'partial', httpStatus: 207 };
    return { status: 'failed', httpStatus: response.status };
  } catch {
    return { status: 'failed', httpStatus: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
