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
  /** A picture with no usable page or area; never kept. */
  skippedInvalid: number;
}

/**
 * Which pictures of a parse result become image chunks: those with a valid page that cover at least MIN_PAGE_AREA_SHARE of it, in page
 * order (parser order within a page), the first MAX_PICTURES_PER_DOCUMENT of them. Small pictures are dropped before the cap, so a
 * decoration never takes the place of a figure. The result depends on the pictures only, so a resumed run selects the same ones.
 */
export function selectPictures(pictures: readonly ParsedPicture[]): PictureSelection {
  const ordered = pictures
    .map((picture, position) => ({ picture, position }))
    .sort((a, b) => a.picture.page - b.picture.page || a.position - b.position);
  const eligible: ParsedPicture[] = [];
  let skippedSmall = 0;
  let skippedInvalid = 0;
  for (const { picture } of ordered) {
    if (!Number.isInteger(picture.page) || picture.page < 1 || !Number.isFinite(picture.page_area_share) || picture.page_area_share < 0) {
      skippedInvalid += 1;
    } else if (picture.page_area_share < MIN_PAGE_AREA_SHARE) {
      skippedSmall += 1;
    } else {
      eligible.push(picture);
    }
  }
  return {
    kept: eligible.slice(0, MAX_PICTURES_PER_DOCUMENT),
    skippedSmall,
    skippedOverCap: Math.max(0, eligible.length - MAX_PICTURES_PER_DOCUMENT),
    skippedInvalid,
  };
}
