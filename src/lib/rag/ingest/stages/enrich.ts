import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { detectLanguage } from '../../lang/detect';
import { getLanguageSettings } from '../../lang/settings';
import { UND, detectChunkLanguages, documentLanguages, type ChunkLanguage, type ChunkLanguageOptions } from '../lang/chunk-language';
import { tableRowLanguage, tableRowSeparator } from '../text/table-rows';
import { countTokens } from '../text/tokens';
import { chunkLexicalText } from '../../lexical/chunk-text';
import { ingestLexical, lexicalStampMetadata } from '../lexical-options';
import { contentHash } from '../hash';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** D-13 needs the enabled languages; without them the switch-off path runs. */
function chunkLanguageOptions(): ChunkLanguageOptions | null {
  const settings = getLanguageSettings();
  if (!settings.configured || settings.languages.length === 0) return null;
  return { candidates: settings.languages, primary: settings.primary, monolingual: settings.monolingual };
}

/** D-13: each chunk's own language and confidence; the document gets the token-weighted dominant language and its language list. */
async function writeChunkLanguages(ctx: StageContext, documentId: string, options: ChunkLanguageOptions): Promise<string | null> {
  const drafts = ctx.work.chunks;
  const results = detectChunkLanguages(
    drafts.map((draft) => draft.content),
    options,
  );
  drafts.forEach((draft, index) => {
    draft.language = results[index]!.language;
    draft.language_confidence = results[index]!.confidence;
  });
  const tokenCounts = drafts.map((draft) => countTokens(draft.content));
  const { language, languages } = documentLanguages(results, tokenCounts);
  ctx.state.traceFacts = { ...ctx.state.traceFacts, ...languageTraceFacts(results, tokenCounts) };
  await ctx.writer.setFields(documentId, language === null ? { languages } : { language, languages });
  return language;
}

/** D-51: each detected language's token share (2 decimals) and the number of und chunks; codes and numbers only. */
export function languageTraceFacts(
  results: readonly ChunkLanguage[],
  tokenCounts: readonly number[],
): { language_shares: Record<string, number>; und_count: number } {
  const tokens = new Map<string, number>();
  let total = 0;
  let undCount = 0;
  results.forEach((result, index) => {
    if (result.language === UND) {
      undCount += 1;
      return;
    }
    const count = Math.max(0, Math.trunc(tokenCounts[index] ?? 0));
    tokens.set(result.language, (tokens.get(result.language) ?? 0) + count);
    total += count;
  });
  const shares: Record<string, number> = {};
  if (total > 0) for (const code of [...tokens.keys()].sort()) shares[code] = Math.round(((tokens.get(code) ?? 0) / total) * 100) / 100;
  return { language_shares: shares, und_count: undCount };
}

/**
 * Per chunk: the lexical text (path prefix plus content), the normalised chunk content hash and the URL
 * metadata storeDocument writes (D-07 keeps it for every document). The dominant language goes on the
 * document row; the writer mirrors it onto the chunks, unless RAG_LANGUAGE_AWARE_INGEST gives each chunk its own. With
 * RAG_TABLE_ROW_SERIALIZATION a table chunk's lexical text also gets its column=value row lines (D-21); content is never changed.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'enrich');

  const filename = requireIdentity(ctx, 'enrich').filename;
  const languageOptions = ctx.config.languageAwareIngest === 'on' ? chunkLanguageOptions() : null;
  let documentLanguage: string | null = null;
  if (languageOptions) {
    documentLanguage = await writeChunkLanguages(ctx, document.id, languageOptions);
  } else {
    documentLanguage = detectLanguage(ctx.work.parseText ?? ctx.work.chunks.map((draft) => draft.content).join('\n'));
    if (documentLanguage !== null) await ctx.writer.setFields(document.id, { language: documentLanguage });
  }
  ctx.work.documentLanguage = documentLanguage;
  // D-55: the language is known before any lexical text is built; one resolve per document (plan 04.2-19).
  const lexical = await ingestLexical(ctx);
  const stamps = lexicalStampMetadata(lexical);

  const rowSerialization = ctx.config.tableRowSerialization === true;
  const primary = rowSerialization ? getLanguageSettings().primary : null;
  for (const draft of ctx.work.chunks) {
    const separator = tableRowSeparator(
      rowSerialization,
      draft.chunk_kind,
      tableRowLanguage({ chunkLanguage: draft.language, documentLanguage, primary }),
    );
    if (separator !== null) draft.table_row_separator = separator;
    draft.lexical_text = chunkLexicalText({
      sectionPath: draft.section_path,
      content: draft.content,
      chunkKind: draft.chunk_kind,
      metadata: draft.metadata,
      documentFilename: filename,
      ...(separator !== null ? { tableRowSeparator: separator } : {}),
    }, lexical.resolved.options);
    draft.content_hash = contentHash(draft.content);
    draft.metadata = {
      ...(enrichChunkWithURLs(draft.content, draft.metadata) as Record<string, unknown>),
      ...stamps,
    };
  }

  const detection = ctx.state.docTypeDetection?.detection;
  if (detection && ctx.identity) {
    // The type may have been refined after parse; the row, its profile and the detection that decided it are stored once, before the chunks are written.
    const { docType, docTypeOrigin, profile } = ctx.identity;
    await ctx.writer.setFields(document.id, {
      doc_type: docType,
      doc_type_origin: docTypeOrigin,
      processing_profile_id: profile.id,
      processing_profile_version: profile.version,
      metadata: { doc_type_detection: detection },
    });
  }
  return { kind: 'next' };
}

export const enrichStage: StageSpec = { name: 'enrich', minMsNeeded: 0, run };
