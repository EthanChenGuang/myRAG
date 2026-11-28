import { createHash } from 'node:crypto';

/** What the sample needs to know about an inventory entry. */
export interface SampleCandidate {
  sourceKey: string;
  ext: string;
  size: number;
}

export type SizeBucket = 'small' | 'medium' | 'large';

/** D-33 step 2: the sample starts at 1% of the files and grows up to 5% until every class seen by preflight has 20 files. */
export const SAMPLE_INITIAL_SHARE = 0.01;
export const SAMPLE_MAX_SHARE = 0.05;
export const SAMPLE_MIN_PER_CLASS = 20;

const SMALL_MAX_BYTES = 256 * 1024;
const MEDIUM_MAX_BYTES = 4 * 1024 * 1024;

export interface SampleSelection<T extends SampleCandidate> {
  /** The whole sample (the initial files, every file sampled before, and the files added now), ordered by source key. */
  entries: T[];
  /** Size of the initial stratified sample. */
  initial: number;
  /** The most files the sample may hold. */
  cap: number;
  /** Files added by this call to grow short classes. */
  added: number;
  byStratum: Record<string, { files: number; sampled: number }>;
}

export function sizeBucket(size: number): SizeBucket {
  if (size < SMALL_MAX_BYTES) return 'small';
  if (size < MEDIUM_MAX_BYTES) return 'medium';
  return 'large';
}

/** A stratum is the extension and the size bucket of a file. */
export function stratumOf(candidate: Pick<SampleCandidate, 'ext' | 'size'>): string {
  return `${candidate.ext.toLowerCase() || 'none'}:${sizeBucket(candidate.size)}`;
}

/** mulberry32 seeded from sha256(seed, salt): the same batch draws the same sample on every resume. */
function seededRandom(seed: string, salt: string): () => number {
  let state = createHash('sha256').update(seed).update('\u0000').update(salt).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T extends SampleCandidate>(items: T[], seed: string, salt: string): T[] {
  const out = [...items].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  const random = seededRandom(seed, salt);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * One file of every stratum, then the rest of the 1% to the strata furthest below their proportional share (largest deficit first,
 * ties by stratum name).
 */
function initialQuotas(sizes: Map<string, number>, total: number, target: number): Map<string, number> {
  const quotas = new Map<string, number>();
  let assigned = 0;
  for (const [stratum, size] of sizes) {
    if (size > 0) {
      quotas.set(stratum, 1);
      assigned += 1;
    }
  }
  const names = [...quotas.keys()].sort();
  while (assigned < target) {
    let best: string | null = null;
    let bestDeficit = -Infinity;
    for (const name of names) {
      const quota = quotas.get(name) as number;
      const size = sizes.get(name) as number;
      if (quota >= size) continue;
      const deficit = (target * size) / total - quota;
      if (deficit > bestDeficit) {
        best = name;
        bestDeficit = deficit;
      }
    }
    if (best === null) break;
    quotas.set(best, (quotas.get(best) as number) + 1);
    assigned += 1;
  }
  return quotas;
}

/**
 * D-33 step 2. Without classes it returns the initial sample: 1% of the files stratified by extension and size bucket, at least one
 * file of every stratum. `preflightClasses` maps every file sampled so far to the class preflight gave it (null when its sample job
 * found none); a class with fewer than 20 sampled files grows from the strata it was seen in, round-robin across short classes, until it
 * has 20 files, its strata have no file left (a smaller class is taken whole), or the sample holds 5% of the inventory. Deterministic for
 * a seed, so a resumed batch draws the same files.
 */
export function selectSample<T extends SampleCandidate>(
  inventory: readonly T[],
  preflightClasses: ReadonlyMap<string, string | null>,
  seed: string,
): SampleSelection<T> {
  const byStratumItems = new Map<string, T[]>();
  for (const entry of inventory) {
    const stratum = stratumOf(entry);
    const list = byStratumItems.get(stratum);
    if (list) list.push(entry);
    else byStratumItems.set(stratum, [entry]);
  }
  const order = new Map<string, T[]>();
  for (const [stratum, items] of byStratumItems) order.set(stratum, shuffled(items, seed, stratum));

  const total = inventory.length;
  const target = Math.min(total, Math.max(Math.ceil(total * SAMPLE_INITIAL_SHARE), byStratumItems.size));
  const cap = Math.min(total, Math.max(target, Math.ceil(total * SAMPLE_MAX_SHARE)));

  const chosen = new Map<string, T>();
  const quotas = initialQuotas(new Map([...byStratumItems].map(([name, items]) => [name, items.length])), total, target);
  for (const [stratum, quota] of quotas) {
    for (const entry of (order.get(stratum) ?? []).slice(0, quota)) chosen.set(entry.sourceKey, entry);
  }
  const bySourceKey = new Map(inventory.map((entry) => [entry.sourceKey, entry] as const));
  for (const key of preflightClasses.keys()) {
    const entry = bySourceKey.get(key);
    if (entry) chosen.set(key, entry);
  }

  const classCounts = new Map<string, number>();
  const classStrata = new Map<string, Set<string>>();
  for (const [key, docClass] of preflightClasses) {
    if (docClass === null) continue;
    classCounts.set(docClass, (classCounts.get(docClass) ?? 0) + 1);
    const entry = bySourceKey.get(key);
    if (!entry) continue;
    const strata = classStrata.get(docClass) ?? new Set<string>();
    strata.add(stratumOf(entry));
    classStrata.set(docClass, strata);
  }

  const need = new Map<string, number>();
  for (const [docClass, count] of [...classCounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count < SAMPLE_MIN_PER_CLASS && classStrata.has(docClass)) need.set(docClass, SAMPLE_MIN_PER_CLASS - count);
  }
  const cursors = new Map<string, number>();
  const rotation = new Map<string, number>();
  const nextFrom = (stratum: string): T | null => {
    const items = order.get(stratum) ?? [];
    let cursor = cursors.get(stratum) ?? 0;
    while (cursor < items.length && chosen.has((items[cursor] as T).sourceKey)) cursor += 1;
    cursors.set(stratum, cursor);
    return cursor < items.length ? (items[cursor] as T) : null;
  };

  let added = 0;
  while (chosen.size < cap) {
    let progressed = false;
    for (const [docClass, remaining] of need) {
      if (remaining <= 0 || chosen.size >= cap) continue;
      const strata = [...(classStrata.get(docClass) as Set<string>)].sort();
      const start = rotation.get(docClass) ?? 0;
      let picked: T | null = null;
      for (let step = 0; step < strata.length && !picked; step += 1) {
        const stratum = strata[(start + step) % strata.length] as string;
        picked = nextFrom(stratum);
        if (picked) rotation.set(docClass, (start + step + 1) % strata.length);
      }
      if (!picked) {
        need.set(docClass, 0);
        continue;
      }
      chosen.set(picked.sourceKey, picked);
      need.set(docClass, remaining - 1);
      added += 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  const byStratum: SampleSelection<T>['byStratum'] = {};
  for (const [stratum, items] of byStratumItems) byStratum[stratum] = { files: items.length, sampled: 0 };
  for (const entry of chosen.values()) (byStratum[stratumOf(entry)] as { sampled: number }).sampled += 1;

  const entries = [...chosen.values()].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  return { entries, initial: target, cap, added, byStratum };
}
