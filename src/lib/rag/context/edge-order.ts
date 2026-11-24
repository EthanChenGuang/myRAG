/** Odd ranks first ascending, then even ranks descending (F-24). */
export function edgeOrder<T>(byRank: T[]): T[] {
  const front: T[] = [];
  const back: T[] = [];
  byRank.forEach((item, i) => (i % 2 === 0 ? front.push(item) : back.unshift(item)));
  return [...front, ...back];
}