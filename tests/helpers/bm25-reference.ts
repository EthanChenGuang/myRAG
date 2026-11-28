// Independent BM25 (Lucene IDF) for tests and the benchmark. It shares no code with the SQL
// scorer or with src/lib/rag/rerank/local-bm25.ts, which uses pool-relative IDF and normalises.

export interface Bm25Stats {
  N: number;
  avgdl: number;
  df: Map<string, number> | Record<string, number>;
}

export interface Bm25ReferenceInput {
  docs: readonly (readonly string[])[];
  query: readonly string[];
  k1: number;
  b: number;
  stats?: Bm25Stats;
}

function corpusStats(docs: readonly (readonly string[])[]): Bm25Stats {
  const df = new Map<string, number>();
  let totalLength = 0;
  for (const doc of docs) {
    totalLength += doc.length;
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return { N: docs.length, avgdl: docs.length > 0 ? totalLength / docs.length : 0, df };
}

function lookupDf(df: Bm25Stats['df'], term: string): number {
  if (df instanceof Map) return df.get(term) ?? 0;
  return Object.prototype.hasOwnProperty.call(df, term) ? df[term] : 0;
}

export function bm25Reference(input: Bm25ReferenceInput): number[] {
  const { docs, k1, b } = input;
  const stats = input.stats ?? corpusStats(docs);
  const terms = [...new Set(input.query)];
  if (terms.length === 0 || stats.N <= 0) return docs.map(() => 0);

  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = Math.min(Math.max(lookupDf(stats.df, term), 1), stats.N);
    idf.set(term, Math.log(1 + (stats.N - df + 0.5) / (df + 0.5)));
  }

  return docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    const lengthNorm = stats.avgdl > 0 ? doc.length / stats.avgdl : 0;
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      score += (idf.get(term) as number) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * lengthNorm)));
    }
    return score;
  });
}

export interface Bm25ClusterDoc {
  id: string;
  tokens: readonly string[];
  cluster?: string | null;
}

export interface Bm25ClusterReferenceInput {
  docs: readonly Bm25ClusterDoc[];
  query: readonly string[];
  k1: number;
  b: number;
}

/**
 * D-46 statistics over units: a document without a cluster is a unit; per cluster the document with the smallest id is the unit.
 * N, avgdl and df are computed over the units; every document is scored with its own term frequencies and length.
 */
export function bm25ClusterStats(docs: readonly Bm25ClusterDoc[]): Bm25Stats {
  const units = new Map<string, Bm25ClusterDoc>();
  for (const doc of docs) {
    const key = doc.cluster ? `c:${doc.cluster}` : `d:${doc.id}`;
    const held = units.get(key);
    if (!held || doc.id < held.id) units.set(key, doc);
  }
  return corpusStats([...units.values()].map((u) => u.tokens));
}

export function bm25ClusterReference(input: Bm25ClusterReferenceInput): number[] {
  return bm25Reference({
    docs: input.docs.map((d) => d.tokens),
    query: input.query,
    k1: input.k1,
    b: input.b,
    stats: bm25ClusterStats(input.docs),
  });
}
