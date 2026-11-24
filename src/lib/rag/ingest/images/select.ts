import type { ParseResult } from '@/lib/rag-eval/contracts.generated';

export type ParsedPicture = ParseResult['pictures'][number];

/** A picture covering less than this share of its page is decoration (a rule, a bullet, a logo strip) and is not captioned. */
export const MIN_PAGE_AREA_SHARE = 0.02;
/** The most pictures one document keeps, in page order. */
export const MAX_PICTURES_PER_DOCUMENT = 30;

export interface PictureSelection {
  /** The pictures to caption, in page order. */
  kept: ParsedPicture[];
  skippedSmall: number;
  skippedOverCap: number;
}

export function selectPictures(_pictures: readonly ParsedPicture[]): PictureSelection {
  return { kept: [], skippedSmall: 0, skippedOverCap: 0 };
}
