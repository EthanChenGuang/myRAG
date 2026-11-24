import { embedText } from './fixture-embedder.mts';
import { lexicalTokens, queryLexicalTokens } from '../../src/lib/rag/lexical/tokenize';

export interface FakeRerankOptions {
  languageOffsets?: Partial<Record<'zh' | 'en' | 'it', number>>;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

function documentFrequency(docs: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const term of lexicalTokens(doc)) {
      if (seen.has(term)) continue;
      seen.add(term);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

function coverageScore(query: string, doc: string, df: Map<string, number>, totalDocs: number): number {
  const queryTerms = queryLexicalTokens(query);
  if (queryTerms.length === 0) return 0;
  const docSet = new Set(lexicalTokens(doc));
  let matched = 0;
  let total = 0;
  for (const term of queryTerms) {
    const freq = df.get(term) ?? 0;
    const idf = Math.log((totalDocs - freq + 0.5) / (freq + 0.5));
    const weight = Math.max(idf, 0);
    total += weight;
    if (docSet.has(term)) matched += weight;
  }
  if (total === 0) return 0;
  return matched / total;
}

function detectDocLanguage(text: string): 'zh' | 'en' | 'it' {
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) han += 1;
    else if (/\p{Script=Latin}/u.test(ch)) latin += 1;
  }
  if (han > latin && han > 0) return 'zh';
  const lower = text.toLowerCase();
  if (/\b(il|lo|la|di|per|che|non|sono|una|politica|rimborso)\b/.test(lower)) return 'it';
  return 'en';
}

export function fakeRerankScores(query: string, docs: string[], options: FakeRerankOptions = {}): number[] {
  const df = documentFrequency(docs);
  const n = docs.length;
  const queryVec = embedText(query);
  return docs.map((doc) => {
    const embedScore = cosine(queryVec, embedText(doc));
    const coverage = coverageScore(query, doc, df, Math.max(n, 1));
    const language = detectDocLanguage(doc);
    const offset = options.languageOffsets?.[language] ?? 0;
    return clamp01(0.6 * embedScore + 0.4 * coverage + offset);
  });
}