import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { rateLimitEnvSchema, rateLimitFallbackMultiplier, unknownIpPolicy } from '../config';
import {
  clientIpFromHeaders,
  consumeFallback,
  getRateLimitCounters,
  normalizeClientIp,
  rateLimit,
  rateLimitKey,
  recordUnknownIp,
  slidingRetryAfterMs,
} from './rate-limit';

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

describe('rateLimitEnvSchema', () => {
  const valid = {
    REDIS_URL: 'redis://localhost:6379',
    RATE_LIMIT_ENABLED: 'true',
    CLIENT_IP_SOURCE: 'x-forwarded-for',
    UNKNOWN_IP_POLICY: 'deny',
    UNKNOWN_IP_STRICT_MAX: '3',
    TRUSTED_PROXY_HOPS: '0',
    REDIS_COMMAND_TIMEOUT_MS: '200',
    RATE_LIMIT_FALLBACK_MULTIPLIER: '2',
    DOCS_CHAT_RATE_LIMIT_MAX: '10',
    DOCS_CHAT_RATE_LIMIT_WINDOW_MS: '60000',
    DOCS_FEEDBACK_RATE_LIMIT_MAX: '15',
    DOCS_FEEDBACK_RATE_LIMIT_WINDOW_MS: '60000',
  };

  it('accepts sane values and coerces numbers', () => {
    const parsed = rateLimitEnvSchema.parse(valid);
    expect(parsed.DOCS_CHAT_RATE_LIMIT_MAX).toBe(10);
    expect(parsed.DOCS_CHAT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(parsed.TRUSTED_PROXY_HOPS).toBe(0);
  });

  it('rejects a zero max instead of silently blocking everyone', () => {
    expect(rateLimitEnvSchema.safeParse({ ...valid, DOCS_CHAT_RATE_LIMIT_MAX: '0' }).success)
      .toBe(false);
  });

  it('rejects negative hops, bad URLs and unknown enums', () => {
    expect(rateLimitEnvSchema.safeParse({ ...valid, TRUSTED_PROXY_HOPS: '-1' }).success).toBe(false);
    expect(rateLimitEnvSchema.safeParse({ ...valid, REDIS_URL: 'http://localhost' }).success).toBe(false);
    expect(rateLimitEnvSchema.safeParse({ ...valid, RATE_LIMIT_ENABLED: 'yes' }).success).toBe(false);
    expect(rateLimitEnvSchema.safeParse({ ...valid, CLIENT_IP_SOURCE: 'x-bogus' }).success).toBe(false);
  });

  it('allows an empty REDIS_URL to disable limiting', () => {
    expect(rateLimitEnvSchema.safeParse({ ...valid, REDIS_URL: '' }).success).toBe(true);
  });

  it('rejects invalid unknown-IP policy and strict max', () => {
    expect(rateLimitEnvSchema.safeParse({ ...valid, UNKNOWN_IP_POLICY: 'allow' }).success)
      .toBe(false);
    expect(rateLimitEnvSchema.safeParse({ ...valid, UNKNOWN_IP_STRICT_MAX: '0' }).success)
      .toBe(false);
  });
});

describe('slidingRetryAfterMs', () => {
  it('waits only as long as the previous key needs to decay within this window', () => {
    // now=0, window=1000, prev=10 at weight 1, current=9 -> estimate 19 > 10.
    // Need prev weight <= 1/10 -> ~900ms.
    expect(slidingRetryAfterMs({ now: 0, windowMs: 1_000, current: 9, prev: 10, max: 10 }))
      .toBeCloseTo(900, 5);
  });

  it('falls back to the next window when decay cannot happen in time', () => {
    // now=900 -> 100ms left; current=10 already equals max, so wait for rollover.
    expect(slidingRetryAfterMs({ now: 900, windowMs: 1_000, current: 10, prev: 10, max: 10 }))
      .toBe(100);
  });

  it('handles a current count above max by decaying it in the next window', () => {
    // current=12, prev=0, max=10. The current key does not decay in its own
    // window, so wait for rollover (1000ms) then 12*(1-t/1000) <= 10 -> ~166.67ms.
    expect(slidingRetryAfterMs({ now: 0, windowMs: 1_000, current: 12, prev: 0, max: 10 }))
      .toBeCloseTo(1_000 + 1_000 * (1 - 10 / 12), 5);
  });
});

describe('consumeFallback', () => {
  const max = 3;
  const limit = Math.max(1, Math.floor(max * rateLimitFallbackMultiplier));

  it('enforces a looser but finite limit while Redis is down', () => {
    const key = 'test:fallback:limit';
    for (let i = 0; i < limit; i += 1) {
      expect(consumeFallback(key, max, 60_000, 'test-route', 'redis_unavailable', undefined, 1_000).allowed)
        .toBe(true);
    }
    expect(consumeFallback(key, max, 60_000, 'test-route', 'redis_unavailable', undefined, 1_000).allowed)
      .toBe(false);
  });

  it('resets the bucket after the window elapses', () => {
    const key = 'test:fallback:reset';
    const start = 10_000;
    for (let i = 0; i < limit; i += 1) {
      consumeFallback(key, max, 1_000, 'test-route', 'redis_error', new Error('boom'), start);
    }
    expect(consumeFallback(key, max, 1_000, 'test-route', 'redis_error', undefined, start).allowed)
      .toBe(false);
    expect(consumeFallback(key, max, 1_000, 'test-route', 'redis_error', undefined, start + 1_001).allowed)
      .toBe(true);
  });

  it('increments the degraded counter per request', () => {
    const before = getRateLimitCounters()['counter-test']?.degraded ?? 0;
    consumeFallback('test:fallback:counter', 3, 60_000, 'counter-test', 'redis_unavailable', undefined, 1);
    consumeFallback('test:fallback:counter', 3, 60_000, 'counter-test', 'redis_unavailable', undefined, 1);
    expect(getRateLimitCounters()['counter-test']?.degraded).toBe(before + 2);
  });
});

describe('unknown IP policy', () => {
  it('increments the unknown-IP counter', () => {
    const before = getRateLimitCounters()['unknown-counter-test']?.unknownIp ?? 0;
    recordUnknownIp('unknown-counter-test');
    expect(getRateLimitCounters()['unknown-counter-test']?.unknownIp).toBe(before + 1);
  });

  it('denies a request with no client IP when the policy is deny', async () => {
    // Only meaningful with the default deny policy; the strict policy is
    // validated by the schema test above.
    if (unknownIpPolicy !== 'deny') return;
    const app = new Hono();
    app.post('/x', rateLimit({ name: 'unknown-test', max: 10, windowMs: 60_000 }));
    app.post('/x', c => c.text('ok'));

    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('0');
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: 'Too many requests', retryAfterSeconds: 60 });
  });
});
