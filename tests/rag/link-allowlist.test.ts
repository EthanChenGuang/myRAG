import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { LinkCheckResultSchema } from '@/lib/rag-eval/contracts.generated';
import { isAllowedHost, normalizeHost, parseLinkAllowlist } from '@/lib/rag/security/link-allowlist';
import { checkLinks, loadLinkRules } from '@/lib/rag/security/link-check';
import { extractLinkCandidates, extractURLs } from '@/lib/url-extractor';

const APP = 'https://app.myrag.example';

describe('parseLinkAllowlist and isAllowedHost (D-35)', () => {
  const allowlist = parseLinkAllowlist('Example.com, sub.other.org., bücher.example', APP);

  test('entries are normalized: lower case, no trailing dot, punycode, the app host always added', () => {
    expect([...allowlist].sort()).toEqual(['app.myrag.example', 'example.com', 'sub.other.org', 'xn--bcher-kva.example']);
  });

  test('the three plan entries and the app host', () => {
    expect([...parseLinkAllowlist('Example.com, sub.other.org.', APP)].sort()).toEqual(['app.myrag.example', 'example.com', 'sub.other.org']);
  });

  test.each(['example.com', 'www.example.com', 'a.b.example.com', 'EXAMPLE.com.', 'app.myrag.example', 'xn--bcher-kva.example', 'shop.bücher.example', 'x.sub.other.org'])(
    '%s is allowed',
    (host) => {
      expect(isAllowedHost(host, allowlist)).toBe(true);
    },
  );

  test.each(['evilexample.com', 'example.com.evil.org', 'notexample.com', '', 'other.org', 'example.co', 'myrag.example', 'bcher-kva.example'])('%s is not allowed', (host) => {
    expect(isAllowedHost(host, allowlist)).toBe(false);
  });

  test('an empty allowlist holds only the app host', () => {
    const empty = parseLinkAllowlist('', APP);
    expect([...empty]).toEqual(['app.myrag.example']);
    expect(isAllowedHost('example.com', empty)).toBe(false);
    expect(isAllowedHost('app.myrag.example', empty)).toBe(true);
    expect([...parseLinkAllowlist('', '')]).toEqual([]);
  });

  test('invalid entries are left out and an IP address matches only itself', () => {
    const list = parseLinkAllowlist(' , ,http://, 10.0.0.1, https://docs.example.net/path', null);
    expect([...list].sort()).toEqual(['10.0.0.1', 'docs.example.net']);
    expect(isAllowedHost('10.0.0.1', list)).toBe(true);
    expect(isAllowedHost('1.10.0.0.1', list)).toBe(false);
  });

  test('normalizeHost', () => {
    expect(normalizeHost('HTTPS://Docs.Example.COM./a?b')).toBe('docs.example.com');
    expect(normalizeHost('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('a..b')).toBeNull();
  });
});

describe('extractLinkCandidates', () => {
  const rules = loadLinkRules();

  test('URLs, e-mail addresses, www hosts and bare domains, in order of appearance', () => {
    const text = 'See https://docs.example.com/a). Mail ops@sample.example.org or visit www.sample.example.net and phish-example.net today.';
    expect(extractLinkCandidates(text, rules)).toEqual([
      { kind: 'url', value: 'https://docs.example.com/a' },
      { kind: 'email', value: 'ops@sample.example.org' },
      { kind: 'domain', value: 'www.sample.example.net' },
      { kind: 'domain', value: 'phish-example.net' },
    ]);
  });

  test('CJK text around a link does not join it', () => {
    expect(extractLinkCandidates('请访问https://phish.example.net/login获取说明，或联系ops@phish.example.net。', rules)).toEqual([
      { kind: 'url', value: 'https://phish.example.net/login' },
      { kind: 'email', value: 'ops@phish.example.net' },
    ]);
  });

  test('file names, version numbers, section numbers and abbreviations are not domains', () => {
    const text = 'Open report.pdf and notes.docx (v2.0, see 3.2.1, e.g. Art. 5, i.e. 第3.2条). Run setup.py, read README.md, index.html, data.json. End.Next';
    expect(extractLinkCandidates(text, rules)).toEqual([]);
  });

  test('extractURLs keeps its results for existing callers', () => {
    const result = extractURLs('Read https://docs.example.com/guide and www.example.org/page today.');
    expect(result.urls.map((url) => url.url)).toEqual(['https://docs.example.com/guide', 'https://example.org/page']);
  });
});

describe('checkLinks', () => {
  const allowlist = parseLinkAllowlist('example.com', APP);

  test('only targets outside the allowlist, sorted by kind and then target, de-duplicated', () => {
    const text = [
      'zeta.example.net and alpha.example.net, again alpha.example.net',
      'https://phish.example.net/login https://docs.example.com/a https://phish.example.net/login',
      'ops@outside.example.org and team@example.com',
      `${APP}/help`,
    ].join('\n');
    const result = checkLinks(text, { allowlist, annotationTargets: ['https://Annot.Example.ORG/x', '#page=2', 'https://docs.example.com/b'] });
    const { dropped: _dropped, ...stored } = result;
    expect(LinkCheckResultSchema.parse(stored)).toEqual(stored);
    expect(result.status).toBe('untrusted_found');
    expect(result.dropped).toBe(0);
    expect(result.targets).toEqual([
      { kind: 'url', target: 'https://phish.example.net/login', host: 'phish.example.net' },
      { kind: 'domain', target: 'alpha.example.net', host: 'alpha.example.net' },
      { kind: 'domain', target: 'zeta.example.net', host: 'zeta.example.net' },
      { kind: 'email', target: 'ops@outside.example.org', host: 'outside.example.org' },
      { kind: 'annotation', target: 'https://annot.example.org/x', host: 'annot.example.org' },
    ]);
  });

  test('the same targets in another order give the same result', () => {
    const a = checkLinks('b.example.net a.example.net ops@c.example.org', { allowlist });
    const b = checkLinks('ops@c.example.org a.example.net b.example.net a.example.net', { allowlist });
    expect(a).toEqual(b);
  });

  test('a text with no link is clean; released targets are skipped', () => {
    expect(checkLinks('The blue module joins the second relay.', { allowlist })).toEqual({
      status: 'clean',
      targets: [],
      checker_version: `link-check/${loadLinkRules().rules_version}`,
      dropped: 0,
    });
    const released = checkLinks('https://phish.example.net/login and new.example.net', { allowlist, releasedTargets: ['https://phish.example.net/login'] });
    expect(released.targets?.map((target) => target.target)).toEqual(['new.example.net']);
  });

  test('at most max_targets are kept and the rest counted', () => {
    const text = Array.from({ length: 130 }, (_, index) => `host${String(index).padStart(3, '0')}.example.net`).join(' ');
    const result = checkLinks(text, { allowlist });
    expect(result.targets).toHaveLength(100);
    expect(result.dropped).toBe(30);
    expect(result.targets?.[0]?.target).toBe('host000.example.net');
  });

  test('the two modules import no network client', () => {
    for (const file of ['src/lib/rag/security/link-allowlist.ts', 'src/lib/rag/security/link-check.ts']) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/\bfetch\(|node:(?:dns|http|https|net)|axios|undici/);
    }
  });
});
