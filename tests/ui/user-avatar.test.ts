import { describe, expect, it } from 'vitest';
import { getUserAvatar } from '@/lib/user-avatar';

describe('getUserAvatar', () => {
  it('uses the provider picture when present', () => {
    const a = getUserAvatar({ email: 'sample.user@example.com', user_metadata: { avatar_url: 'https://example.com/a.png', full_name: 'Sample User' } });
    expect(a.imageUrl).toBe('https://example.com/a.png');
    expect(a.initials).toBe('SU');
  });

  it('falls back to the Google picture field', () => {
    expect(getUserAvatar({ user_metadata: { picture: 'https://example.com/p.png' } }).imageUrl).toBe('https://example.com/p.png');
  });

  it('rejects non-https picture urls', () => {
    expect(getUserAvatar({ user_metadata: { avatar_url: 'javascript:alert(1)' } }).imageUrl).toBeNull();
    expect(getUserAvatar({ user_metadata: { avatar_url: 'http://example.com/a.png' } }).imageUrl).toBeNull();
  });

  it('takes initials from the display name, not the email', () => {
    const a = getUserAvatar({ email: 'zz@example.com', user_metadata: { full_name: 'Alex Morgan Lee' } });
    expect(a.imageUrl).toBeNull();
    expect(a.initials).toBe('AL');
  });

  it('handles single-word and CJK display names', () => {
    expect(getUserAvatar({ user_metadata: { name: 'sample' } }).initials).toBe('SA');
    expect(getUserAvatar({ user_metadata: { full_name: '张三' } }).initials).toBe('张三');
  });

  it('falls back to the email local part when there is no display name', () => {
    expect(getUserAvatar({ email: 'sample.user@example.com', user_metadata: {} }).initials).toBe('SU');
  });

  it('returns nothing without a user', () => {
    expect(getUserAvatar(null)).toEqual({ imageUrl: null, initials: null });
  });
});
