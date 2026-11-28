import type { GateContext, Lang, Transform } from '@/lib/rag/query/rewrite-gate';

export type GateFixture = {
  name: string;
  q: string;
  lang: Lang;
  ctx: Omit<GateContext, 'now'>;
  transforms: Transform[];
  reason?: string;
  protectedTokens?: string[];
  skipRetrieval?: boolean;
};

const HIST = { hasHistory: true };
const NO_HIST = { hasHistory: false };

// The spec's required fixture table (.planning/specs/query-rewrite-gate.md), zh/en/it each.
export const GATE_FIXTURES: readonly GateFixture[] = [
  { name: 'R1 pronoun with history', q: '它的保修期多久？', lang: 'zh', ctx: HIST, transforms: ['condense_history'], reason: 'R1_PRONOUN' },
  { name: 'R1 pronoun with history', q: 'How long is its warranty?', lang: 'en', ctx: HIST, transforms: ['condense_history'], reason: 'R1_PRONOUN' },
  { name: 'R1 pronoun with history', q: 'Quanto dura la sua garanzia?', lang: 'it', ctx: HIST, transforms: ['condense_history'], reason: 'R1_PRONOUN' },

  { name: 'pronoun without history', q: '它的保修期多久？', lang: 'zh', ctx: NO_HIST, transforms: [] },
  { name: 'pronoun without history', q: 'How long is its warranty?', lang: 'en', ctx: NO_HIST, transforms: [] },
  { name: 'pronoun without history', q: 'Quanto dura la sua garanzia?', lang: 'it', ctx: NO_HIST, transforms: [] },

  { name: 'R2 relative time', q: '去年的营收是多少？', lang: 'zh', ctx: NO_HIST, transforms: ['normalize_dates'], reason: 'R2_RELATIVE_TIME' },
  { name: 'R2 relative time', q: 'What was revenue last year?', lang: 'en', ctx: NO_HIST, transforms: ['normalize_dates'], reason: 'R2_RELATIVE_TIME' },
  { name: 'R2 relative time', q: "Qual è stato il fatturato l'anno scorso?", lang: 'it', ctx: NO_HIST, transforms: ['normalize_dates'], reason: 'R2_RELATIVE_TIME' },

  { name: 'R3 comparison', q: 'A 和 B 有什么区别？', lang: 'zh', ctx: NO_HIST, transforms: ['decompose'], reason: 'R3_COMPARISON' },
  { name: 'R3 comparison', q: 'What is the difference between A and B?', lang: 'en', ctx: NO_HIST, transforms: ['decompose'], reason: 'R3_COMPARISON' },
  { name: 'R3 comparison', q: 'Qual è la differenza tra A e B?', lang: 'it', ctx: NO_HIST, transforms: ['decompose'], reason: 'R3_COMPARISON' },

  { name: 'R4 exact code, complete', q: 'ERR_TIMEOUT 是什么意思？', lang: 'zh', ctx: NO_HIST, transforms: [], reason: 'R4_EXACT_CODE', protectedTokens: ['ERR_TIMEOUT'] },
  { name: 'R4 exact code, complete', q: 'What does ERR_TIMEOUT mean?', lang: 'en', ctx: NO_HIST, transforms: [], reason: 'R4_EXACT_CODE', protectedTokens: ['ERR_TIMEOUT'] },
  { name: 'R4 exact code, complete', q: 'Cosa significa ERR_TIMEOUT?', lang: 'it', ctx: NO_HIST, transforms: [], reason: 'R4_EXACT_CODE', protectedTokens: ['ERR_TIMEOUT'] },

  { name: 'R1 + R4 fix: code in a follow-up is condensed and protected', q: '那个 ERR_TIMEOUT 怎么修？', lang: 'zh', ctx: HIST, transforms: ['condense_history'], reason: 'R1_PRONOUN', protectedTokens: ['ERR_TIMEOUT'] },
  { name: 'R1 + R4 fix: code in a follow-up is condensed and protected', q: 'How do I fix that ERR_TIMEOUT?', lang: 'en', ctx: HIST, transforms: ['condense_history'], reason: 'R1_PRONOUN', protectedTokens: ['ERR_TIMEOUT'] },
  { name: 'R1 + R4 fix: code in a follow-up is condensed and protected', q: 'Come risolvo questo ERR_TIMEOUT?', lang: 'it', ctx: HIST, transforms: ['condense_history'], reason: 'R1_PRONOUN', protectedTokens: ['ERR_TIMEOUT'] },

  { name: 'R0 too short', q: '退款', lang: 'zh', ctx: NO_HIST, transforms: ['expand'], reason: 'R0_TOO_SHORT' },
  { name: 'R0 too short', q: 'refund', lang: 'en', ctx: NO_HIST, transforms: ['expand'], reason: 'R0_TOO_SHORT' },
  { name: 'R0 too short', q: 'rimborso', lang: 'en', ctx: NO_HIST, transforms: ['expand'], reason: 'R0_TOO_SHORT' },

  { name: 'R5 elliptical follow-up', q: '那意大利呢？', lang: 'zh', ctx: HIST, transforms: ['condense_history'], reason: 'R5_ELLIPTICAL' },
  { name: 'R5 elliptical follow-up', q: 'What about Italy?', lang: 'en', ctx: HIST, transforms: ['condense_history'], reason: 'R5_ELLIPTICAL' },
  { name: 'R5 elliptical follow-up', q: "E per l'Italia?", lang: 'it', ctx: HIST, transforms: ['condense_history'], reason: 'R5_ELLIPTICAL' },

  { name: 'R8 language mismatch', q: 'What is the hotel reimbursement limit?', lang: 'en', ctx: { hasHistory: false, kbLang: 'zh' }, transforms: ['translate'], reason: 'R8_LANGUAGE_MISMATCH' },
  { name: 'R8 language mismatch', q: '酒店的报销上限是多少？', lang: 'zh', ctx: { hasHistory: false, kbLang: 'en' }, transforms: ['translate'], reason: 'R8_LANGUAGE_MISMATCH' },
  { name: 'R8 language mismatch', q: "Qual è il limite di rimborso per l'hotel?", lang: 'it', ctx: { hasHistory: false, kbLang: 'zh' }, transforms: ['translate'], reason: 'R8_LANGUAGE_MISMATCH' },

  { name: 'R9 keyword-only', q: '酒店 报销 上限', lang: 'zh', ctx: NO_HIST, transforms: ['expand'], reason: 'R9_KEYWORDS' },
  { name: 'R9 keyword-only', q: 'hotel reimbursement limit', lang: 'en', ctx: NO_HIST, transforms: ['expand'], reason: 'R9_KEYWORDS' },
  { name: 'R9 keyword-only', q: 'limite rimborso hotel', lang: 'en', ctx: NO_HIST, transforms: ['expand'], reason: 'R9_KEYWORDS' },

  { name: 'R12 small talk', q: '你好', lang: 'zh', ctx: NO_HIST, transforms: [], reason: 'R12_SMALL_TALK', skipRetrieval: true },
  { name: 'R12 small talk', q: 'thanks', lang: 'en', ctx: NO_HIST, transforms: [], reason: 'R12_SMALL_TALK', skipRetrieval: true },
  { name: 'R12 small talk', q: 'grazie!', lang: 'en', ctx: NO_HIST, transforms: [], reason: 'R12_SMALL_TALK', skipRetrieval: true },

  { name: 'R11 long complete question', q: '我们公司员工在出差期间入住酒店时每晚可以报销的最高金额是多少', lang: 'zh', ctx: NO_HIST, transforms: [], reason: 'R11_LONG_COMPLETE' },
  { name: 'R11 long complete question', q: 'What is the maximum amount per night that our company employees can claim for hotel stays during business trips abroad?', lang: 'en', ctx: NO_HIST, transforms: [], reason: 'R11_LONG_COMPLETE' },
  { name: 'R11 long complete question', q: "Qual è l'importo massimo per notte che i dipendenti della nostra azienda possono chiedere a rimborso per gli hotel durante le trasferte?", lang: 'it', ctx: NO_HIST, transforms: [], reason: 'R11_LONG_COMPLETE' },

  { name: '该 inside 应该 does not fire R1', q: '应该怎么申请？', lang: 'zh', ctx: HIST, transforms: [] },
];
