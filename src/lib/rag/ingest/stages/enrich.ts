import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { detectLanguage } from '../../lang/detect';
import { LEXICAL_VERSION, chunkLexicalText } from '../../lexical/chunk-text';
import { contentHash } from '../hash';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/**
 * Per chunk: the lexical text (path prefix plus content), the normalised chunk content hash and the URL
 * metadata storeDocument writes (D-07 keeps it for every document). The dominant language goes on the
 * document row; the writer mirrors it onto the chunks.
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

  const language = detectLanguage(ctx.work.parseText ?? ctx.work.chunks.map((draft) => draft.content).join('\n'));
  if (language !== null) await ctx.writer.setFields(document.id, { language });

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
