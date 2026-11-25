export function icuSegmentsChinese(): boolean {
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    const words = [...seg.segment('适用范围')].filter((s) => s.isWordLike).map((s) => s.segment);
    return words.join('|') === '适用|范围';
  } catch {
    return false;
  }
}

export function assertIcuSegmentsChinese(): void {
  if (icuSegmentsChinese()) return;
  throw new Error(`[RAG Config] ICU cannot segment Chinese as expected (icu ${process.versions.icu})`);
}