import type { FusedHit } from './rrf';

/**
 * Interleaves the fused order with the standalone query's own order, standalone first: the standalone query's i-th hit
 * never ranks below position 2i - 1, so variant hits (sub-questions, expansions, translations) add evidence without
 * displacing it. Rows keep their fused score and ranks; ids absent from `fused` are ignored.
 */
export function anchorToStandalone(fused: FusedHit[], anchorOrder: readonly string[]): FusedHit[] {
  if (anchorOrder.length === 0 || fused.length < 2) return fused;
  const byId = new Map(fused.map((row) => [row.hit.chunkId, row]));
  const anchor = anchorOrder.filter((id, index) => byId.has(id) && anchorOrder.indexOf(id) === index);
  const out: FusedHit[] = [];
  const placed = new Set<string>();
  let a = 0;
  let f = 0;
  const take = (id: string) => {
    placed.add(id);
    out.push(byId.get(id)!);
  };
  while (out.length < fused.length) {
    while (a < anchor.length && placed.has(anchor[a]!)) a++;
    if (a < anchor.length) take(anchor[a++]!);
    while (f < fused.length && placed.has(fused[f]!.hit.chunkId)) f++;
    if (f < fused.length) take(fused[f++]!.hit.chunkId);
  }
  return out;
}
