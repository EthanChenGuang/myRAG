export type EmbedRatingLocale = 'en' | 'zh' | 'it';
export type EmbedRatingVote = 'helpful' | 'not_helpful';
export type EmbedRatingReason = 'wrong' | 'incomplete' | 'not_relevant';

export interface EmbedRatingStrings {
  group: string;
  helpful: string;
  notHelpful: string;
  reasonsLegend: string;
  reasons: Record<EmbedRatingReason, string>;
  saved: string;
  failed: string;
  rateLimited: string;
}

export const EMBED_RATING_REASONS: readonly EmbedRatingReason[] = ['wrong', 'incomplete', 'not_relevant'];

/** D-11 copy for the embed rating, shared by the widget script and the embed window (UI-SPEC 12.3). */
export const EMBED_RATING_STRINGS: Record<EmbedRatingLocale, EmbedRatingStrings> = {
  en: {
    group: 'Rate This Answer',
    helpful: 'Helpful',
    notHelpful: 'Not Helpful',
    reasonsLegend: 'What Went Wrong? (Optional)',
    reasons: { wrong: 'Wrong', incomplete: 'Incomplete', not_relevant: 'Not Relevant' },
    saved: 'Thanks for your feedback.',
    failed: 'Your rating was not saved. Select it again to retry.',
    rateLimited: 'Too many ratings just now. Wait a moment, then select it again.',
  },
  zh: {
    group: '评价这条回答',
    helpful: '有帮助',
    notHelpful: '没有帮助',
    reasonsLegend: '哪里有问题？（可选）',
    reasons: { wrong: '内容错误', incomplete: '不完整', not_relevant: '答非所问' },
    saved: '感谢你的反馈。',
    failed: '评价未能保存。请再选一次。',
    rateLimited: '评价过于频繁。请稍等片刻再选。',
  },
  it: {
    group: 'Valuta questa risposta',
    helpful: 'Utile',
    notHelpful: 'Non utile',
    reasonsLegend: 'Cosa non va? (facoltativo)',
    reasons: { wrong: 'Sbagliata', incomplete: 'Incompleta', not_relevant: 'Non pertinente' },
    saved: 'Grazie per il feedback.',
    failed: 'La valutazione non è stata salvata. Selezionala di nuovo per riprovare.',
    rateLimited: 'Troppe valutazioni in poco tempo. Attendi un momento, poi selezionala di nuovo.',
  },
};

export function embedRatingLocale(language: string | null | undefined): EmbedRatingLocale {
  const prefix = String(language ?? '').slice(0, 2).toLowerCase();
  return prefix === 'zh' || prefix === 'it' ? prefix : 'en';
}
