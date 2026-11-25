import { describe, expect, test } from 'vitest';
import { allowedImageHosts, imageLinkHref, isAllowedImageUrl } from '@/lib/safe-image-hosts';

const hosts = allowedImageHosts({
  supabaseUrl: 'https://Project-Ref.supabase.example',
  headerLogoUrl: 'https://logo.example/brand/header.svg',
  aiLogoUrl: 'not a url',
});

describe('allowedImageHosts', () => {
  test('derives lower-cased hosts and ignores unparsable values', () => {
    expect(hosts).toEqual({ supabaseHost: 'project-ref.supabase.example', logoHosts: ['logo.example'] });
  });

  test('empty and missing values give no hosts', () => {
    expect(allowedImageHosts({ supabaseUrl: '', headerLogoUrl: null })).toEqual({ supabaseHost: null, logoHosts: [] });
  });

  test('logo host and ai logo host are both kept, deduplicated', () => {
    const both = allowedImageHosts({ headerLogoUrl: 'https://a.example/x.png', aiLogoUrl: 'https://A.example/y.png' });
    expect(both.logoHosts).toEqual(['a.example']);
    const two = allowedImageHosts({ headerLogoUrl: 'https://a.example/x.png', aiLogoUrl: 'https://b.example/y.png' });
    expect(two.logoHosts).toEqual(['a.example', 'b.example']);
  });
});

describe('isAllowedImageUrl', () => {
  test.each([
    '/api/files/x.png',
    'https://project-ref.supabase.example/storage/v1/object/public/bucket/a.png',
    'https://replicate.delivery/xezq/a.png',
    'https://logo.example/brand/header.svg',
    'https://logo.example/other/path.png',
  ])('allows %s', (src) => {
    expect(isAllowedImageUrl(src, hosts)).toBe(true);
  });

  test.each([
    'http://replicate.delivery/xezq/a.png',
    'http://replicate.delivery/a.png',
    'https://replicate.delivery/other/a.png',
    'https://project-ref.supabase.example/storage/v1/object/sign/a.png',
    'https://project-ref.supabase.example/storage/v1/object/public/../sign/a.png',
    'https://project-ref.supabase.example/storage/v1/object/public/%2e%2e/sign/a.png',
    'https://project-ref.supabase.example/rest/v1/documents',
    'http://project-ref.supabase.example/storage/v1/object/public/bucket/a.png',
    '//attacker.example/a.png',
    '/\\attacker.example/a.png',
    '\\\\attacker.example/a.png',
    'https://user@replicate.delivery/xezq/a.png',
    'https://user:pass@replicate.delivery/xezq/a.png',
    'https://replicate.delivery:8443/xezq/a.png',
    'https://replicate.delivery.attacker.example/xezq/a.png',
    'https://attacker.example/replicate.delivery/xezq/a.png',
    'https://replicate.delivery./xezq/a.png',
    'https://evil-replicate.delivery/xezq/a.png',
    'https://logo.example.attacker.example/x.png',
    'http://logo.example/x.png',
    'https://attacker.example/x.png?q=secret',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'blob:https://replicate.delivery/1234',
    'ftp://replicate.delivery/xezq/a.png',
    'x.png',
    ' https://attacker.example/x.png',
    '/api/files/x.png\nhttps://attacker.example',
    '',
    'https://',
    'https://[::1',
  ])('rejects %j', (src) => {
    expect(isAllowedImageUrl(src, hosts)).toBe(false);
  });

  test.each([undefined, null, 42, {}])('rejects non-string %j', (src) => {
    expect(isAllowedImageUrl(src, hosts)).toBe(false);
  });

  test('without a Supabase host, a storage URL on any host is rejected', () => {
    const none = allowedImageHosts({});
    expect(isAllowedImageUrl('https://project-ref.supabase.example/storage/v1/object/public/b/a.png', none)).toBe(false);
    expect(isAllowedImageUrl('https://replicate.delivery/xezq/a.png', none)).toBe(true);
  });
});

describe('imageLinkHref', () => {
  test.each(['https://attacker.example/x.png?q=1', 'http://attacker.example/x.png'])('links %s', (src) => {
    expect(imageLinkHref(src)).toBe(src);
  });

  test.each(['data:image/png;base64,AAAA', 'javascript:alert(1)', 'blob:https://a.example/1', '//a.example/x', 'x.png', '', ' https://a.example/x', 'https://a.example/\\x', undefined])(
    'gives no link for %j',
    (src) => {
      expect(imageLinkHref(src)).toBeNull();
    },
  );
});
