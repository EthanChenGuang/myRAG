import { describe, expect, it } from 'vitest';
import lexicon from '@/lib/rag/query/rewrite-gate.lexicon.json';
import { detectGateLanguage } from '@/lib/rag/query/gate-language';
import { extractProtectedTokens, keepsProtectedTokens } from '@/lib/rag/query/protected';

describe('extractProtectedTokens', () => {
  it('keeps exact codes from the R4 pattern', () => {
    expect(extractProtectedTokens('ERR_TIMEOUT 是什么意思？')).toEqual(['ERR_TIMEOUT']);
    expect(extractProtectedTokens('model AB12 vs AB13')).toEqual(['AB12', 'AB13']);
  });

  it('keeps quoted spans in every quote style', () => {
    expect(extractProtectedTokens('什么是「保修」条款')).toEqual(['保修']);
    expect(extractProtectedTokens('what does “refund” cover')).toEqual(['refund']);
    expect(extractProtectedTokens('cosa copre «rimborso»')).toEqual(['rimborso']);
    expect(extractProtectedTokens('search for "x" please')).toEqual(['x']);
  });

  it('keeps URLs and e-mail addresses', () => {
    expect(extractProtectedTokens('see https://example.com/docs/a?b=1 for details')).toEqual([
      'https://example.com/docs/a?b=1',
    ]);
    expect(extractProtectedTokens('write to support@example.com today')).toEqual(['support@example.com']);
  });

  it('keeps numbers with units or currency, explicit dates and version strings', () => {
    expect(extractProtectedTokens('超过500元怎么办')).toEqual(['500元']);
    expect(extractProtectedTokens('is €1,200 the cap?')).toEqual(['€1,200']);
    expect(extractProtectedTokens('a 30% discount')).toEqual(['30%']);
    expect(extractProtectedTokens('signed on 2026-03-01')).toEqual(['2026-03-01']);
    expect(extractProtectedTokens('upgrade to v2.3.1 now')).toEqual(['v2.3.1']);
  });

  it('deduplicates and keeps first-seen order', () => {
    expect(extractProtectedTokens('AB13 or AB12 then AB13 again at 30%')).toEqual(['AB13', 'AB12', '30%']);
  });

  it('returns nothing for plain text', () => {
    expect(extractProtectedTokens('how long is the warranty')).toEqual([]);
    expect(extractProtectedTokens('应该怎么申请？')).toEqual([]);
  });
});

describe('keepsProtectedTokens', () => {
  it('accepts a text that keeps every token verbatim', () => {
    expect(keepsProtectedTokens('fix ERR_TIMEOUT now', ['ERR_TIMEOUT'])).toBe(true);
    expect(keepsProtectedTokens('anything', [])).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(keepsProtectedTokens('fix err_timeout now', ['ERR_TIMEOUT'])).toBe(false);
  });

  it('rejects full-width digits in place of ASCII digits', () => {
    expect(keepsProtectedTokens('model AB１２ specs', ['AB12'])).toBe(false);
  });

  it('compares NFC-normalized forms', () => {
    const nfc = 'caffè «perché»'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(keepsProtectedTokens(`ordine ${nfd}`, [nfc])).toBe(true);
    expect(keepsProtectedTokens(`ordine ${nfc}`, [nfd])).toBe(true);
  });

  it('rejects a text missing one of several tokens', () => {
    expect(keepsProtectedTokens('compare AB12 only', ['AB12', 'AB13'])).toBe(false);
  });
});

describe('detectGateLanguage', () => {
  it('returns zh when CJK characters are at least 30%', () => {
    expect(detectGateLanguage('它的保修期多久？')).toBe('zh');
    expect(detectGateLanguage('那个 ERR_TIMEOUT 怎么修？')).toBe('zh');
  });

  it('returns it when the Italian stopword score is higher', () => {
    expect(detectGateLanguage('Qual è la differenza tra A e B?')).toBe('it');
  });

  it('returns en otherwise', () => {
    expect(detectGateLanguage('What is the difference between A and B?')).toBe('en');
    expect(detectGateLanguage('refund')).toBe('en');
  });

  it('classifies a mixed query by its dominant script', () => {
    expect(detectGateLanguage('请问 VPN 连接失败应该怎么处理')).toBe('zh');
    expect(detectGateLanguage('What is the meaning of 保修 in the contract?')).toBe('en');
  });
});

describe('rewrite-gate lexicon', () => {
  const REQUIRED_KEYS = [
    'pronouns',
    'relative_time',
    'comparison',
    'elliptical',
    'compound',
    'vague',
    'small_talk',
    'question_markers',
    'stopwords',
    'personal_data',
    'first_person',
    'patterns',
  ] as const;

  it('has every required key', () => {
    for (const key of REQUIRED_KEYS) {
      expect(lexicon, key).toHaveProperty(key);
    }
  });

  it('keys word lists by zh, en and it', () => {
    for (const key of ['pronouns', 'relative_time', 'comparison', 'elliptical', 'compound', 'vague', 'small_talk', 'question_markers', 'first_person'] as const) {
      expect(Object.keys(lexicon[key]).sort(), key).toEqual(['en', 'it', 'zh']);
    }
    expect(Object.keys(lexicon.stopwords).sort()).toEqual(['en', 'it']);
  });

  it('stores relative time as structured entries', () => {
    const lastYear = lexicon.relative_time.en.find((entry) => entry.term === 'last year');
    expect(lastYear).toMatchObject({ unit: 'year', offset: -1 });
    expect(lexicon.relative_time.zh.some((entry) => 'n_placeholder' in entry && entry.n_placeholder)).toBe(true);
  });

  it('holds personal-data patterns that compile', () => {
    for (const [name, source] of Object.entries(lexicon.personal_data)) {
      expect(() => new RegExp(source, 'u'), name).not.toThrow();
    }
    expect(new RegExp(lexicon.personal_data.cn_resident_id, 'u').test('11010519491231002X')).toBe(true);
    expect(new RegExp(lexicon.personal_data.it_codice_fiscale, 'u').test('RSSMRA85T10A562S')).toBe(true);
  });
});
