import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { detectLanguage } from '../../lang/detect';
import { lexicalText } from '../../lexical/tokenize';
import { contentHash } from '../hash';
import { requireDocument, type StageContext, type StageOutcome, type StageSpec } from '../types';

/**
 * Per chunk: the lexical text (path prefix plus content), the normalised chunk content hash and the URL
 * metadata storeDocument writes (D-07 keeps it for every document). The dominant language goes on the
 * document row; the writer mirrors it onto the chunks.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const document = requireDocument(ctx, 'enrich');

  for (const draft of ctx.work.chunks) {
    draft.lexical_text = lexicalText(draft.section_path, draft.content);
    draft.content_hash = contentHash(draft.content);
    draft.metadata = enrichChunkWithURLs(draft.content, draft.metadata) as Record<string, unknown>;
  }

  const language = detectLanguage(ctx.work.parseText ?? ctx.work.chunks.map((draft) => draft.content).join('\n'));
  if (language !== null) await ctx.writer.setFields(document.id, { language });
  return { kind: 'next' };
}

export const enrichStage: StageSpec = { name: 'enrich', minMsNeeded: 0, run };
