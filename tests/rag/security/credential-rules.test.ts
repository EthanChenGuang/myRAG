import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import fixture from '../../fixtures/output-guard/answers.json';
import { OutputGuardRulesSchema } from '@/lib/rag-eval/contracts.generated';
import { createOutputLinkPolicy } from '@/lib/rag/security/link-targets';
import { createOutputGuard, guardWholeText, type OutputGuardPolicy } from '@/lib/rag/security/output-guard';
import {
  loadOutputGuardRules,
  matchCredentialSentence,
  outputGuardRulesVersion,
} from '@/lib/rag/security/credential-rules';
import * as injectionScan from '@/lib/rag/security/injection-scan';

const RULES_FILE = path.join(process.cwd(), 'config', 'rag', 'output-guard-rules.json');
const LANGUAGES = ['zh', 'en', 'it'] as const;

function tempRules(raw: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'output-guard-rules-'));
  const file = path.join(dir, 'rules.json');
  writeFileSync(file, JSON.stringify(raw, null, 2));
  return file;
}

const REQUESTS: Record<(typeof LANGUAGES)[number], string[]> = {
  en: [
    'Please enter your verification code to continue.',
    'Reply with your password so the account can be confirmed.',
    'ＥＮＴＥＲ ＹＯＵＲ ＶＥＲＩＦＩＣＡＴＩＯＮ ＣＯＤＥ now.',
    'Enter your pass​word here.',
    'What is your one-time code?',
  ],
  zh: ['请输入您的验证码以继续。', '请提供你的密码。', '请输​入验证码。', '请输入ＰＩＮ码。'],
  it: [
    'Inserisci il codice di verifica per continuare.',
    'Inviami la tua password.',
    'INSERISCI IL CODICE DI VERIFICA.',
    'Fornisci le tue credenziali di accesso.',
  ],
};

const MENTIONS: Record<(typeof LANGUAGES)[number], string[]> = {
  en: [
    'The password policy requires twelve characters.',
    'A verification code is sent after the form is saved.',
    'Please enter the date of the report.',
    'Enter your name in the first field.',
    'The spinning wheel shows progress.',
  ],
  zh: ['密码策略要求十二个字符。', '系统会发送验证码。', '请输入报告日期。'],
  it: ['La password deve avere dodici caratteri.', 'Il sistema invia un codice di verifica.', 'Inserisci la data del documento.'],
};

describe('normalise export', () => {
  it('is the shared NFKC normaliser of injection-scan', () => {
    const normalise = (injectionScan as Record<string, unknown>).normalise;
    expect(typeof normalise).toBe('function');
    const fn = normalise as (text: string, invisible: '' | ' ') => string;
    expect(fn('ＡＢ​Ｃ  D', '')).toBe('abc d');
  });
});

describe('loadOutputGuardRules', () => {
  it('loads the committed file through the generated schema with credential rules for zh, en and it', () => {
    const rules = loadOutputGuardRules();
    expect(OutputGuardRulesSchema.parse(rules)).toEqual(rules);
    for (const language of LANGUAGES) {
      expect((rules.credential_rules ?? []).filter((rule) => rule.language === language).length, language).toBeGreaterThan(0);
    }
  });

  it('rejects an invalid file and an obfuscation pattern with a backreference', () => {
    const raw = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
    expect(() => loadOutputGuardRules(tempRules({ ...raw, version: '' }))).toThrow();
    const backref = { ...raw, obfuscation_patterns: [{ id: 'obf.backref', pattern: '^(a)\\1$' }] };
    expect(() => loadOutputGuardRules(tempRules(backref))).toThrow(/back-?reference/i);
    const named = { ...raw, obfuscation_patterns: [{ id: 'obf.named', pattern: '^(?<x>a)\\k<x>$' }] };
    expect(() => loadOutputGuardRules(tempRules(named))).toThrow(/back-?reference/i);
  });
});

describe('outputGuardRulesVersion', () => {
  it('is the first 12 hex characters of the file sha256 and changes with the file', () => {
    expect(outputGuardRulesVersion()).toMatch(/^[a-f0-9]{12}$/);
    expect(outputGuardRulesVersion(RULES_FILE)).toBe(outputGuardRulesVersion());
    const raw = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
    const a = tempRules(raw);
    const b = tempRules({ ...raw, version: `${raw.version}-x` });
    expect(outputGuardRulesVersion(a)).toMatch(/^[a-f0-9]{12}$/);
    expect(outputGuardRulesVersion(a)).not.toBe(outputGuardRulesVersion(b));
  });
});

describe('matchCredentialSentence', () => {
  for (const language of LANGUAGES) {
    for (const sentence of REQUESTS[language]) {
      it(`${language}: matches a request: ${JSON.stringify(sentence)}`, () => {
        expect(matchCredentialSentence(sentence, language).length).toBeGreaterThan(0);
        expect(matchCredentialSentence(sentence).length).toBeGreaterThan(0);
      });
    }
    for (const sentence of MENTIONS[language]) {
      it(`${language}: does not match a mention or a request without a secret: ${JSON.stringify(sentence)}`, () => {
        expect(matchCredentialSentence(sentence, language)).toEqual([]);
        expect(matchCredentialSentence(sentence)).toEqual([]);
      });
    }
  }

  it('returns rule ids of the requested language only when a language is given', () => {
    const ids = matchCredentialSentence('Please enter your verification code.', 'en');
    const rules = loadOutputGuardRules().credential_rules ?? [];
    for (const id of ids) expect(rules.find((rule) => rule.id === id)?.language).toMatch(/^(en|any)$/);
    expect(matchCredentialSentence('Please enter your verification code.', 'zh')).toEqual([]);
  });
});

describe('output guard credential sentences (D-39)', () => {
  const PLACEHOLDER = '(link removed)';
  const BLOCKED = '[credential sentence blocked]';
  const REQUEST = 'Please enter your verification code now.';

  interface Notice {
    kind: string;
    textId: string;
  }

  function credentialPolicy(mode: 'flag' | 'enforce', extra: Partial<OutputGuardPolicy> = {}) {
    const notices: Notice[] = [];
    const policy: OutputGuardPolicy = {
      mode,
      placeholder: PLACEHOLDER,
      credentialBlocked: BLOCKED,
      links: createOutputLinkPolicy({ allowlistValue: 'allowed.test', siteUrl: 'https://app.example', userMessage: 'A neutral question.' }),
      onNotice: (notice: Notice) => notices.push(notice),
      ...extra,
    } as OutputGuardPolicy;
    return { policy, notices };
  }

  function stream(text: string, policy: OutputGuardPolicy) {
    const guard = createOutputGuard(policy);
    let out = '';
    let pushed = 0;
    let maxHeld = 0;
    for (const char of text) {
      out += guard.push('t', char);
      pushed += char.length;
      maxHeld = Math.max(maxHeld, pushed - out.length);
    }
    out += guard.flush('t');
    return { out, maxHeld, summary: guard.summary() };
  }

  it('keeps a matching sentence and warns once when nothing removed or flagged', () => {
    const { policy, notices } = credentialPolicy('enforce');
    const text = `Intro first. ${REQUEST} Then more text. ${REQUEST}`;
    const result = stream(text, policy);
    expect(result.out).toBe(text);
    expect(result.summary.credential_warned).toBe(2);
    expect(result.summary.credential_blocked).toBe(0);
    expect(result.summary.rule_ids).toContain('cred.en.request-secret');
    expect(notices).toEqual([{ kind: 'credential_request_warning', textId: 't' }]);
    expect(guardWholeText(text, policy).text).toBe(text);
  });

  it('blocks the matching sentence when the answer removed a link earlier', () => {
    const { policy, notices } = credentialPolicy('enforce');
    const text = `See https://other.test/a now. ${REQUEST} Bye.`;
    const expected = `See ${PLACEHOLDER} now. ${BLOCKED} Bye.`;
    const result = stream(text, policy);
    expect(result.out).toBe(expected);
    expect(result.summary.credential_blocked).toBe(1);
    expect(result.summary.credential_warned).toBe(0);
    expect(notices.map((notice) => notice.kind)).toEqual(['credential_request_blocked']);
    expect(guardWholeText(text, policy).text).toBe(expected);
  });

  it('blocks when a removed link sits inside the matching sentence', () => {
    const { policy } = credentialPolicy('enforce');
    const text = 'Please enter your password at https://other.test/login today. Bye.';
    expect(stream(text, policy).out).toBe(`${BLOCKED} Bye.`);
  });

  it('blocks when the turn had flagged context, without any link', () => {
    const { policy } = credentialPolicy('enforce', { flaggedContext: true });
    const text = `Intro first. ${REQUEST} Bye.`;
    const result = stream(text, policy);
    expect(result.out).toBe(`Intro first. ${BLOCKED} Bye.`);
    expect(result.summary.credential_blocked).toBe(1);
  });

  it('records a late block when the link is removed after the sentence was released', () => {
    const { policy, notices } = credentialPolicy('enforce');
    const text = `Intro first. ${REQUEST} See https://other.test/a now.`;
    const result = stream(text, policy);
    expect(result.out).toBe(`Intro first. ${REQUEST} See ${PLACEHOLDER} now.`);
    expect(result.summary.credential_blocked).toBe(1);
    expect(result.summary.credential_warned).toBe(0);
    const start = 'Intro first. '.length;
    expect(result.summary.blockedRanges).toEqual([{ textId: 't', start, end: start + REQUEST.length }]);
    expect(notices.map((notice) => notice.kind)).toEqual(['credential_request_warning', 'credential_request_blocked']);
    const whole = guardWholeText(text, policy);
    expect(whole.text).toBe(`Intro first. ${BLOCKED} See ${PLACEHOLDER} now.`);
    expect(whole.summary.credential_blocked).toBe(1);
  });

  it('records a late block across text blocks of the same answer', () => {
    const { policy } = credentialPolicy('enforce');
    const guard = createOutputGuard(policy);
    const first = guard.push('a', REQUEST) + guard.flush('a');
    const second = guard.push('b', 'See https://other.test/a now.') + guard.flush('b');
    expect(first).toBe(REQUEST);
    expect(second).toBe(`See ${PLACEHOLDER} now.`);
    expect(guard.summary().blockedRanges).toEqual([{ textId: 'a', start: 0, end: REQUEST.length }]);
  });

  it('leaves the text unchanged in flag and records the counts', () => {
    const { policy, notices } = credentialPolicy('flag', { flaggedContext: true });
    const text = `Intro first. ${REQUEST} Bye.`;
    const result = stream(text, policy);
    expect(result.out).toBe(text);
    expect(result.summary.credential_blocked).toBe(1);
    expect(result.summary.blockedRanges).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('decides a long sentence at the 600-character bound and keeps streaming', () => {
    const { policy } = credentialPolicy('enforce', { flaggedContext: true });
    const head = 'Please enter your password ';
    const body = 'word '.repeat(200);
    const text = `${head}${body}end.`;
    const result = stream(text, policy);
    expect(result.maxHeld).toBeLessThanOrEqual(600 + 12);
    expect(result.out).toBe(BLOCKED + text.slice(600));
    expect(result.summary.credential_blocked).toBe(1);
  });

  it('streams ordinary text with at most a word held', () => {
    const { policy } = credentialPolicy('enforce');
    const text = 'The report has three parts and each part has two sections, which the team reviewed twice.';
    const result = stream(text, policy);
    expect(result.out).toBe(text);
    expect(result.maxHeld).toBeLessThanOrEqual(16);
    expect(result.summary.credential_warned).toBe(0);
  });

  it('starts holding only after a rule term was seen', () => {
    const { policy } = credentialPolicy('enforce', { flaggedContext: true });
    const guard = createOutputGuard(policy);
    expect(guard.push('t', 'To continue, ')).toBe('To continue, ');
    expect(guard.push('t', 'please enter your password')).toBe('');
    expect(guard.push('t', '. Next')).toBe(BLOCKED + ' ');
    expect(guard.flush('t')).toBe('Next');
  });
});

describe('clean-answer gate (D-39)', () => {
  const clean = (fixture.answers as { id: string; language: string; text: string; expect: { removed: string[]; credential?: unknown } }[]).filter(
    (answer) => answer.expect.removed.length === 0 && !answer.expect.credential,
  );

  it('has clean answers in zh, en and it', () => {
    for (const language of LANGUAGES) expect(clean.filter((answer) => answer.language === language).length).toBeGreaterThan(0);
  });

  for (const answer of clean) {
    it(`${answer.id}: zero credential matches`, () => {
      expect(matchCredentialSentence(answer.text, answer.language)).toEqual([]);
      expect(matchCredentialSentence(answer.text)).toEqual([]);
    });
  }
});
