import type { StageContext, StageOutcome, StageSpec } from '../types';

/**
 * Picture captioning arrives with plans 03-32 and 03-38. With RAG_PDF_IMAGE_CHUNKS off (the default)
 * the stage passes; switched on before the captioner exists it says so and still passes.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  if (!ctx.config.pdfImageChunks) return { kind: 'next', disabled: true, outcome: 'images_off' };
  ctx.warnings.push('image_chunks_unavailable');
  return { kind: 'next', disabled: true, fallbackReason: 'image_chunks_unavailable' };
}

export const imagesStage: StageSpec = { name: 'images', minMsNeeded: 0, run };
