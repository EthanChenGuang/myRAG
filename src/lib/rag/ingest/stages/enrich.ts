import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { detectLanguage } from '../../lang/detect';
import { getLanguageSettings } from '../../lang/settings';
import { detectChunkLanguages, documentLanguages, type ChunkLanguageOptions } from '../lang/chunk-language';
import { countTokens } from '../text/tokens';
import { LEXICAL_VERSION, chunkLexicalText } from '../../lexical/chunk-text';
import { contentHash } from '../hash';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** D-13 needs the enabled languages; without them the switch-off path runs. */
function chunkLanguageOptions(): ChunkLanguageOptions | null {
  const settings = getLanguageSettings();
  if (!settings.configured || settings.languages.length === 0) return null;
  return { candidates: settings.languages, primary: settings.primary, monolingual: settings.monolingual };
}

/** D-13: each chunk's own language and confidence; the document gets the token-weighted dominant language and its language list. */
async function writeChunkLanguages(ctx: StageContext, documentId: string, options: ChunkLanguageOptions): Promise<void> {
  const drafts = ctx.work.chunks;
  const results = detectChunkLanguages(
    drafts.map((draft) => draft.content),
    options,
  );
  drafts.forEach((draft, index) => {
    draft.language = results[index]!.language;
    draft.language_confidence = results[index]!.confidence;
  });
  const { language, languages } = documentLanguages(
    results,
    drafts.map((draft) => countTokens(draft.content)),
  );
  await ctx.writer.setFields(documentId, language === null ? { languages } : { language, languages });
}

/**
 * Per chunk: the lexical text (path prefix plus content), the normalised chunk content hash and the URL
 * metadata storeDocument writes (D-07 keeps it for every document). The dominant language goes on the
 * document row; the writer mirrors it onto the chunks, unless RAG_LANGUAGE_AWARE_INGEST gives each chunk its own.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'enrich');

  const filename = requireIdentity(ctx, 'enrich').filename;
  for (const draft of ctx.work.chunks) {
    draft.lexical_text = chunkLexicalText({
      sectionPath: draft.section_path,
      content: draft.content,
      chunkKind: draft.chunk_kind,
      metadata: draft.metadata,
      documentFilename: filename,
    });
    draft.content_hash = contentHash(draft.content);
    draft.metadata = {
      ...(enrichChunkWithURLs(draft.content, draft.metadata) as Record<string, unknown>),
      lexical_version: LEXICAL_VERSION,
    };
  }

  const languageOptions = ctx.config.languageAwareIngest === 'on' ? chunkLanguageOptions() : null;
  if (languageOptions) {
    await writeChunkLanguages(ctx, document.id, languageOptions);
  } else {
    const language = detectLanguage(ctx.work.parseText ?? ctx.work.chunks.map((draft) => draft.content).join('\n'));
    if (language !== null) await ctx.writer.setFields(document.id, { language });
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
