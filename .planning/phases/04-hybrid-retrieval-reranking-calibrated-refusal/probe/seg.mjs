const seg = new Intl.Segmenter('zh', { granularity: 'word' });
for (const s of ['王小明', '请问王小明先生负责什么', '型号XR-2000/A_v2.1的保修期', 'ＸＲ－２０００', "l'azienda dell'anno perché società", '统一社会信用代码91310000MA1FL0XX0T', '适用范围', '保修期多长']) {
  console.log(s, '=>', [...seg.segment(s)].filter((x) => x.isWordLike).map((x) => x.segment).join(' | '));
}
console.log('node', process.versions.node, 'icu', process.versions.icu, 'icu_small', process.config.variables.icu_small);
const ss = new Intl.Segmenter('zh', { granularity: 'sentence' });
console.log([...ss.segment('第一句。第二句！价格是3.5元。')].map((x) => x.segment));
const se = new Intl.Segmenter('it', { granularity: 'sentence' });
console.log([...se.segment("Il prezzo è 3.5 euro. Vedi l'art. 5 del contratto. Fine.")].map((x) => x.segment));
const t = '𠮷野家 … 😀';
console.log('utf16', t.length, 'codepoints', Array.from(t).length);
