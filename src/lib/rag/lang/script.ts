export type ChineseScript = 'hans' | 'hant' | 'ambiguous';

/**
 * Frequent characters whose Simplified and Traditional forms differ, as aligned pairs
 * (research Open Question 3). Forms that also occur in the other script (后, 么, 只, 干, 里, 台, 万, 体) are left out.
 */
const SIMPLIFIED_PAIRS = '这们说时国发来过对会为见长门问间开关电车东马鸟鱼书买卖语话认识读写谁请让还没点钱进远运动学习现实经历从乐听讲论边气数题应该处当业机产区与两无样种线结给统头华报记设将务员网图类维级质划计';
const TRADITIONAL_PAIRS = '這們說時國發來過對會為見長門問間開關電車東馬鳥魚書買賣語話認識讀寫誰請讓還沒點錢進遠運動學習現實經歷從樂聽講論邊氣數題應該處當業機產區與兩無樣種線結給統頭華報記設將務員網圖類維級質劃計';

export const SIMPLIFIED_ONLY: ReadonlySet<string> = new Set(SIMPLIFIED_PAIRS);
export const TRADITIONAL_ONLY: ReadonlySet<string> = new Set(TRADITIONAL_PAIRS);

/** Counts script-specific hits; the script with more hits wins, a tie or no hit is ambiguous. */
export function chineseScript(text: string): ChineseScript {
  let simplified = 0;
  let traditional = 0;
  for (const char of text) {
    if (SIMPLIFIED_ONLY.has(char)) simplified += 1;
    else if (TRADITIONAL_ONLY.has(char)) traditional += 1;
  }
  if (simplified > traditional) return 'hans';
  if (traditional > simplified) return 'hant';
  return 'ambiguous';
}
