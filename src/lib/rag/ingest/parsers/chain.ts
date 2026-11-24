import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { isTenantScope } from '../../tenant/scope';
import type { IngestParser } from '../config';
import type { ProcessingProfile } from '../profiles/load';
import { getLlamaParseParser } from './llamaparse-v2';
import { isTextLike, parsePlainText } from './plain-text';
import { getSidecarParser } from './sidecar-docling';
import { ParserError, type DocumentParser, type NetworkParserName, type ParseArtifact, type ParseRequest, type ParserName, type PendingJob } from './shared';

export interface FallbackNote {
  parser: ParserName;
  reason: string;
}

export type ChainOutcome =
  | { kind: 'done'; parser: ParserName; result: ParseResult; artifacts: ParseArtifact[]; warnings: string[]; fallbacks: FallbackNote[] }
  | { kind: 'pending'; job: PendingJob; fallbacks: FallbackNote[] }
  | { kind: 'failed'; reason: 'no_parser_available'; fallbacks: FallbackNote[] };

/**
 * The order parsers are tried in (D-19): the profile's preference with `configured` resolved from RAG_PARSER, then the other
 * parser, then plain text for txt, md and csv. Anything else has no last resort and ends failed.
 */
export function buildParserChain(profile: ProcessingProfile, config: { parser: IngestParser }, file: { filename: string; mimeType: string }): ParserName[] {
  const chain: ParserName[] = [];
  const add = (parser: NetworkParserName): void => {
    if (!chain.includes(parser)) chain.push(parser);
  };
  for (const entry of profile.parser.preference) add(entry === 'configured' ? config.parser : entry);
  add(config.parser);
  add('llamaparse');
  add('docling');
  if (isTextLike(file.filename, file.mimeType)) chain.push('text');
  return chain;
}

function note(fallbacks: FallbackNote[], parser: ParserName, reason: string): void {
  fallbacks.push({ parser, reason });
  console.warn('[Ingest] parser fallback', { parser, reason });
}

function parserFor(name: NetworkParserName): DocumentParser {
  return name === 'llamaparse' ? getLlamaParseParser() : getSidecarParser();
}

/**
 * Tries each parser of the chain until one returns a result or a pending job. A parser that is unavailable or throws is skipped and
 * logged with its reason; an abort ends the run. A resume starts at the parser that owns the saved job, so parsers that already
 * failed are not paid for again.
 */
export async function parseWithFallback(chain: ParserName[], request: ParseRequest): Promise<ChainOutcome> {
  const fallbacks: FallbackNote[] = [];
  const resumeAt = request.resume ? chain.indexOf(request.resume.parser) : -1;
  for (const name of chain.slice(Math.max(0, resumeAt))) {
    request.signal.throwIfAborted();
    if (name === 'text') {
      const result = parsePlainText(request);
      return { kind: 'done', parser: 'text', result, artifacts: [], warnings: [], fallbacks };
    }
    const parser = parserFor(name);
    if (name === 'llamaparse' && !isTenantScope(request.scope)) {
      note(fallbacks, name, 'scope_unverified');
      continue;
    }
    const skipped = parser.unavailableReason({ filename: request.filename, mimeType: request.mimeType });
    if (skipped !== null) {
      note(fallbacks, name, skipped);
      continue;
    }
    try {
      const attempt = await parser.parse({ ...request, resume: request.resume?.parser === name ? request.resume : null });
      if (attempt.kind === 'pending') return { kind: 'pending', job: attempt.job, fallbacks };
      return { kind: 'done', parser: name, result: attempt.result, artifacts: attempt.artifacts, warnings: attempt.warnings, fallbacks };
    } catch (error) {
      if (request.signal.aborted) throw error;
      note(fallbacks, name, error instanceof ParserError ? error.reason : 'error');
    }
  }
  return { kind: 'failed', reason: 'no_parser_available', fallbacks };
}
