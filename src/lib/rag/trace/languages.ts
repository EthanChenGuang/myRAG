import { logLanguageCodes } from '../feedback-loop/log-languages';
import type { RetrievalResult } from '../types';

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const UNDETERMINED = 'und';

/** LANG-10: the query language and its confidence, the kept chunks' languages in rank order and the answer language; codes only. */
export interface TraceLanguages {
  query_language: string | null;
  query_language_confidence: number | null;
  chunk_languages: string[];
  answer_language: string | null;
}

function codeOrNull(value: unknown): string | null {
  return typeof value === 'string' && LANGUAGE_CODE.test(value) ? value : null;
}

/** Pattern-checks a block: a value that is not a code is left out (null, or und for a chunk), as in the FBK-01 writer. */
export function sanitizeTraceLanguages(block: TraceLanguages): TraceLanguages {
  const confidence = block.query_language_confidence;
  const chunks: string[] = [];
  for (const value of Array.isArray(block.chunk_languages) ? block.chunk_languages : []) {
    const code = codeOrNull(value) ?? UNDETERMINED;
    if (!chunks.includes(code)) chunks.push(code);
  }
  return {
    query_language: codeOrNull(block.query_language),
    query_language_confidence: typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
    chunk_languages: chunks,
    answer_language: codeOrNull(block.answer_language),
  };
}

/** The trace block from the same derivation the retrieval log row uses, so both carry the same codes for one request. */
export function traceLanguagesOf(result: RetrievalResult, query: string | undefined): TraceLanguages {
  return sanitizeTraceLanguages(logLanguageCodes(result, query));
}
