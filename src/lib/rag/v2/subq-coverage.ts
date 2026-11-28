import type { FusedHit } from '../fusion/rrf';
import type { QueryVariant } from '../types';

/** D-07: at most 4 reservations per request, whatever the caller passes. */
export const MAX_SUB_QUESTION_RESERVATIONS = 4;

export interface SubQuestionCoverageOptions {
  enabled: boolean;
  max?: number;
}

export interface SubQuestionCoverageResult {
  topK: FusedHit[];
  /** The rest of the ranked list: displaced top-k entries first (in their order), then the unreserved pool. */
  pool: FusedHit[];
  reserved: number;
}

const LIST_ID = /^(?:dense|lexical):(\d+)$/;

/** Sub-question indexes whose dense or lexical list ranked this hit (list id `dense:i` / `lexical:i` → variants[i]). */
export function subQuestionsOf(row: FusedHit, variants: readonly QueryVariant[]): Set<number> {
  const found = new Set<number>();
  for (const listId of Object.keys(row.ranks)) {
    const match = LIST_ID.exec(listId);
    if (!match) continue;
    const index = variants[Number(match[1])]?.subQuestionIndex;
    if (index !== undefined) found.add(index);
  }
  return found;
}

/**
 * D-07: after the single rerank, every sub-question without a chunk in the final top-k gets its best-ranked pool
 * candidate, replacing the lowest-ranked top-k entry that is not the only cover of another sub-question. No rerank.
 */
export function reserveSubQuestionCoverage(
  topK: FusedHit[],
  pool: FusedHit[],
  variants: readonly QueryVariant[],
  options: SubQuestionCoverageOptions,
): SubQuestionCoverageResult {
  const subQuestions = [
    ...new Set(variants.map((variant) => variant.subQuestionIndex).filter((index): index is number => index !== undefined)),
  ].sort((a, b) => a - b);
  const max = Math.min(Math.max(0, Math.floor(options.max ?? MAX_SUB_QUESTION_RESERVATIONS)), MAX_SUB_QUESTION_RESERVATIONS);
  if (!options.enabled || subQuestions.length === 0 || topK.length === 0 || pool.length === 0 || max === 0) {
    return { topK, pool, reserved: 0 };
  }

  const slots = topK.map((row) => ({ row, covers: subQuestionsOf(row, variants), reserved: false }));
  const inTopK = new Set(topK.map((row) => row.hit.chunkId));
  const coverCount = (subQuestion: number) => slots.filter((slot) => slot.covers.has(subQuestion)).length;
  const poolCovers = pool.map((row) => subQuestionsOf(row, variants));
  const taken = new Set<number>();
  const displacedSlots: number[] = [];
  const reservedPoolIndexes: number[] = [];

  for (const subQuestion of subQuestions) {
    if (reservedPoolIndexes.length >= max) break;
    if (coverCount(subQuestion) > 0) continue;
    const poolIndex = pool.findIndex(
      (row, index) => !taken.has(index) && !inTopK.has(row.hit.chunkId) && poolCovers[index]!.has(subQuestion),
    );
    if (poolIndex < 0) continue;

    let slotIndex = -1;
    for (let index = slots.length - 1; index >= 0; index--) {
      const slot = slots[index]!;
      if (slot.reserved) continue;
      if ([...slot.covers].every((covered) => coverCount(covered) > 1)) {
        slotIndex = index;
        break;
      }
    }
    if (slotIndex < 0) break;

    const candidate = pool[poolIndex]!;
    taken.add(poolIndex);
    inTopK.add(candidate.hit.chunkId);
    displacedSlots.push(slotIndex);
    reservedPoolIndexes.push(poolIndex);
    slots[slotIndex] = { row: candidate, covers: poolCovers[poolIndex]!, reserved: true };
  }

  if (reservedPoolIndexes.length === 0) return { topK, pool, reserved: 0 };

  // Reserved candidates fill the freed slots in pool order; every other entry keeps its position.
  const freed = [...displacedSlots].sort((a, b) => a - b);
  const reservedRows = [...reservedPoolIndexes].sort((a, b) => a - b).map((index) => pool[index]!);
  const nextTopK = [...topK];
  freed.forEach((slotIndex, order) => {
    nextTopK[slotIndex] = reservedRows[order]!;
  });
  const displaced = freed.map((slotIndex) => topK[slotIndex]!);
  const finalIds = new Set(nextTopK.map((row) => row.hit.chunkId));
  const rest = pool.filter((row, index) => !taken.has(index) && !finalIds.has(row.hit.chunkId));

  return { topK: nextTopK, pool: [...displaced, ...rest], reserved: reservedRows.length };
}
