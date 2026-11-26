import { effectiveLexicalVersion, loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { resolveLexicalOptions, type LexicalStamp, type ResolvedLexicalOptions } from '../lexical/resolve-options';
import { LEXICAL_VERSION, lexicalText } from '../lexical/tokenize';
import type { StageContext } from './types';

/** The lexical options of one document and the effective version its chunks are stamped with (D-42). */
export interface IngestLexical {
  version: number;
  resolved: ResolvedLexicalOptions;
}

const OFF: IngestLexical = Object.freeze({
  version: LEXICAL_VERSION,
  resolved: Object.freeze({ options: undefined, stamp: Object.freeze({ dictVersion: null, patterns: null }), warnings: [] }) as ResolvedLexicalOptions,
});

/**
 * One resolve per document (plan 04.2-19): enrich resolves with the detected document language and keeps the result on the run's work
 * state, and the extractor, image and profile paths reuse it. With every lexical switch off nothing is resolved and today's options and
 * version apply. Resolver warnings go to the ingestion warnings once.
 */
export async function ingestLexical(ctx: StageContext): Promise<IngestLexical> {
  if (ctx.work.lexical) return ctx.work.lexical;
  const config = loadRagConfig(getRagDeps().ragEnv());
  const { lexicalDictionary, lexicalStemIt, identifierIndex } = config.v2;
  if (!lexicalDictionary && !lexicalStemIt && !identifierIndex) {
    ctx.work.lexical = OFF;
    return OFF;
  }
  const resolved = await resolveLexicalOptions(ctx.input.scope, config, { language: ctx.work.documentLanguage ?? null, signal: ctx.signal });
  for (const warning of resolved.warnings) {
    if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
  }
  const lexical: IngestLexical = { version: effectiveLexicalVersion(config), resolved };
  ctx.work.lexical = lexical;
  return lexical;
}

/** The chunk metadata keys that record the options: the dictionary version and the patterns fingerprint when they were used. */
export function lexicalStampKeys(stamp: LexicalStamp): Record<string, string> {
  return {
    ...(stamp.dictVersion !== null ? { lexical_dict_version: stamp.dictVersion } : {}),
    ...(stamp.patterns !== null ? { lexical_patterns: stamp.patterns } : {}),
  };
}

/** lexical_version plus the stamp keys, as enrich and the profile writer stamp every chunk. */
export function lexicalStampMetadata(lexical: IngestLexical | undefined): Record<string, unknown> {
  if (!lexical) return { lexical_version: LEXICAL_VERSION };
  return { lexical_version: lexical.version, ...lexicalStampKeys(lexical.resolved.stamp) };
}

/**
 * Lexical text and metadata keys for a chunk built after enrich (image captions, the extractor's prefixed text). With the switches off
 * the text is today's and no key is added, so those chunks stay as they are written today.
 */
export function lexicalFieldsFor(lexical: IngestLexical, sectionPath: string[], content: string): { lexical_text: string; metadata: Record<string, unknown> } {
  const options = lexical.resolved.options;
  if (options === undefined && lexical.version === LEXICAL_VERSION && lexical.resolved.stamp.dictVersion === null && lexical.resolved.stamp.patterns === null) {
    return { lexical_text: lexicalText(sectionPath, content), metadata: {} };
  }
  return { lexical_text: lexicalText(sectionPath, content, options), metadata: lexicalStampMetadata(lexical) };
}
