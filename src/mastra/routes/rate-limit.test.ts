import { describe, expect, it } from 'bun:test';

import { clientIpFromHeaders, normalizeClientIp, rateLimitKey } from './rate-limit';

const headers = (values: Record<string, string>) =>
  (name: string): string | undefined => values[name.toLowerCase()];

const xff = (trustedProxyHops = 0) => ({ source: 'x-forwarded-for' as const, trustedProxyHops });

describe('normalizeClientIp', () => {
  it('accepts IPv4 and rejects garbage', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('not-an-ip')).toBeNull();
    expect(normalizeClientIp('203.0.113.7:8080')).toBeNull();
  });

  it('folds IPv6 to its /64 prefix', () => {
    expect(normalizeClientIp('2001:db8:abcd:1234:1:2:3:4')).toBe('2001:0db8:abcd:1234::/64');
    expect(normalizeClientIp('2001:db8:abcd:1234::1')).toBe('2001:0db8:abcd:1234::/64');
  });

  it('collapses IPv4-mapped IPv6 to IPv4', () => {
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('clientIpFromHeaders', () => {
  it('trusts the rightmost entry when the proxy overwrites the chain', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7' }), xff(0)))
      .toBe('203.0.113.7');
  });

  it('ignores a spoofed left entry and trusts N hops from the right', () => {
    expect(
      clientIpFromHeaders(
        headers({ 'x-forwarded-for': '198.51.100.66, 203.0.113.7, 10.0.0.1' }),
        xff(1),
      ),
    ).toBe('203.0.113.7');
  });

  it('rejects chains shorter than the trusted hop count', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7' }), xff(2)))
      .toBeNull();
  });

  it('uses x-real-ip when configured and ignores a spoofed forwarded chain', () => {
    expect(
      clientIpFromHeaders(
        headers({
          'x-forwarded-for': '198.51.100.66',
          'x-real-ip': '203.0.113.7',
        }),
        { source: 'x-real-ip', trustedProxyHops: 0 },
      ),
    ).toBe('203.0.113.7');
  });

  it('returns null when no valid IP is present', () => {
    expect(clientIpFromHeaders(headers({}), xff(0))).toBeNull();
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': 'garbage' }), xff(0))).toBeNull();
  });
});

describe('rateLimitKey', () => {
  it('namespaces buckets by route so one route cannot consume another quota', () => {
    expect(rateLimitKey('docs-chat', '203.0.113.7')).toBe('ratelimit:docs-chat:203.0.113.7');
    expect(rateLimitKey('docs-feedback', '203.0.113.7')).toBe('ratelimit:docs-feedback:203.0.113.7');
  });
});
