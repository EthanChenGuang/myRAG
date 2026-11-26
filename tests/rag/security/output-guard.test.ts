import { describe, expect, it } from 'vitest';

import { OutputGuardSummarySchema } from '@/lib/rag-eval/contracts.generated';
import { createOutputLinkPolicy } from '@/lib/rag/security/link-targets';
import { createOutputGuard, guardWholeText, type OutputGuardPolicy } from '@/lib/rag/security/output-guard';

const PLACEHOLDER = '(link removed)';

function policy(mode: 'flag' | 'enforce' = 'enforce', extra: Partial<Parameters<typeof createOutputLinkPolicy>[0]> = {}) {
  return {
    mode,
    placeholder: PLACEHOLDER,
    links: createOutputLinkPolicy({
      allowlistValue: 'allowed.test',
      siteUrl: 'https://app.example',
      documentNames: ['document-a.md'],
      userMessage: 'A neutral question.',
      ...extra,
    }),
  } satisfies OutputGuardPolicy;
}

function feedByChar(text: string, p: OutputGuardPolicy) {
  const guard = createOutputGuard(p);
  let out = '';
  let maxHeld = 0;
  let pushed = 0;
  for (const char of text) {
    out += guard.push('t', char);
    pushed += char.length;
    maxHeld = Math.max(maxHeld, pushed - out.length);
  }
  out += guard.flush('t');
  return { out, maxHeld, summary: guard.summary() };
}

describe('guardWholeText', () => {
  it('replaces a non-allowlisted URL in enforce and counts it', () => {
    const result = guardWholeText('See https://other.test/a?b=1 now.', policy());
    expect(result.text).toBe(`See ${PLACEHOLDER} now.`);
    expect(result.summary.links_removed).toBe(1);
    expect(result.summary.links_checked).toBe(1);
    expect(result.summary.rule_ids).toContain('link_not_allowlisted');
  });

  it('leaves the text unchanged in flag and still counts', () => {
    const text = 'See https://other.test/a?b=1 now.';
    const result = guardWholeText(text, policy('flag'));
    expect(result.text).toBe(text);
    expect(result.summary.links_removed).toBe(1);
    expect(result.summary.mode).toBe('flag');
  });

  it('keeps the visible text of a removed Markdown link and drops a removed image', () => {
    expect(guardWholeText('[label](https://other.test)', policy()).text).toBe(`label ${PLACEHOLDER}`);
    expect(guardWholeText('Look ![x](https://other.test/i.png) here', policy()).text).toBe(`Look ${PLACEHOLDER} here`);
    expect(guardWholeText('[https://other.test](https://allowed.test)', policy()).text).toBe(
      `[${PLACEHOLDER}](https://allowed.test)`,
    );
  });

  it('passes citation markers and allowlisted links unchanged', () => {
    for (const text of [
      'Answer [S3] and 【S1】 and ［S2］.',
      'Read [the guide](https://docs.allowed.test/guide) first.',
      'Visit allowed.test for details.',
      'Go to https://app.example/chat now.',
    ]) {
      expect(guardWholeText(text, policy()).text).toBe(text);
    }
  });

  it('replaces a non-allowlisted e-mail address and keeps an allowlisted one', () => {
    expect(guardWholeText('contact name@other.test today', policy()).text).toBe(`contact ${PLACEHOLDER} today`);
    expect(guardWholeText('contact name@allowed.test today', policy()).text).toBe('contact name@allowed.test today');
  });

  it('replaces obfuscated, opaque and look-alike forms', () => {
    for (const text of [
      'Open hxxp://example[.]test now',
      'Open example[.]test now',
      'Open example dot test now',
      'Run javascript:alert(1) now',
      'Open https://user:pw@allowed.test/x now',
      'Open https://ｅｘａｍｐｌｅ．test/x now',
    ]) {
      const result = guardWholeText(text, policy());
      expect(result.text).toBe(`${text.split(' ')[0]} ${PLACEHOLDER} now`);
      expect(result.summary.links_removed).toBe(1);
    }
  });

  it('cuts a candidate at CJK punctuation', () => {
    expect(guardWholeText('请访问 https://allowed.test。谢谢', policy()).text).toBe('请访问 https://allowed.test。谢谢');
    expect(guardWholeText('请访问https://other.test，谢谢', policy()).text).toBe(`请访问${PLACEHOLDER}，谢谢`);
  });

  it('passes decimals, versions and context file names', () => {
    for (const text of ['Value 3.5 and v2.1.0 and 1.234,56.', 'See document-a.md for the list.', 'Sentence. Next one.']) {
      const result = guardWholeText(text, policy());
      expect(result.text).toBe(text);
      expect(result.summary.links_checked).toBe(0);
    }
  });

  it('produces a summary that the contract accepts and never serializes removed targets', () => {
    const result = guardWholeText('See https://other.test/secret-path now.', policy());
    expect(OutputGuardSummarySchema.parse(result.summary)).toMatchObject({ links_removed: 1, rules_version: '2026-11-26.2' });
    expect(result.summary.removedTargets).toEqual(['https://other.test/secret-path']);
    expect(JSON.stringify(result.summary)).not.toContain('secret-path');
  });
});

describe('createOutputGuard', () => {
  it('decides a URL longer than the bound at the bound', () => {
    const long = `https://other.test/${'a'.repeat(3000)}`;
    const blocked = feedByChar(`Go ${long} end`, policy());
    expect(blocked.out).toBe(`Go ${PLACEHOLDER} end`);
    const kept = `https://allowed.test/${'a'.repeat(3000)}`;
    const keptResult = feedByChar(`Go ${kept} end`, policy());
    expect(keptResult.out).toBe(`Go ${kept} end`);
    expect(keptResult.maxHeld).toBeLessThanOrEqual(2048);
  });

  it('decides Markdown link text longer than the bound at the bound', () => {
    const text = `[${'x'.repeat(400)}](https://other.test)`;
    const result = feedByChar(text, policy());
    expect(result.out).not.toContain('other.test');
    expect(result.maxHeld).toBeLessThanOrEqual(400 + 2);
    expect(result.out).toBe(guardWholeText(text, policy()).text);
  });

  it('replaces an incomplete held candidate at flush', () => {
    const guard = createOutputGuard(policy());
    expect(guard.push('t', 'Visit https://othe')).toBe('Visit ');
    expect(guard.flush('t')).toBe(PLACEHOLDER);
    const second = createOutputGuard(policy());
    expect(second.push('t', 'Visit https://allowed.te') + second.flush('t')).toBe(`Visit ${PLACEHOLDER}`);
  });

  it('delays a citation marker by one character only', () => {
    const guard = createOutputGuard(policy());
    expect(guard.push('t', 'Fact [S3]')).toBe('Fact ');
    expect(guard.push('t', ' ')).toBe('[S3] ');
    expect(guard.flush('t')).toBe('');
  });

  it('releases prose without candidates after about one word', () => {
    const guard = createOutputGuard(policy());
    expect(guard.push('t', 'Plain prose without candidates')).toBe('Plain prose without ');
    expect(guard.push('t', ' continues')).toBe('candidates ');
    expect(guard.flush('t')).toBe('continues');
  });

  it('keeps separate state per text id', () => {
    const guard = createOutputGuard(policy());
    const a = guard.push('a', 'See https://oth');
    const b = guard.push('b', 'Plain words here ');
    const a2 = guard.push('a', 'er.test now');
    expect(a + a2 + guard.flush('a')).toBe(`See ${PLACEHOLDER} now`);
    expect(b + guard.flush('b')).toBe('Plain words here ');
  });
});
