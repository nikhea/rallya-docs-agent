import { describe, expect, it } from 'bun:test';

import { clientIpFromHeaders, rateLimitKey } from './rate-limit';

const headers = (values: Record<string, string>) =>
  (name: string): string | undefined => values[name.toLowerCase()];

describe('clientIpFromHeaders', () => {
  it('uses the original client from x-forwarded-for', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })))
      .toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when x-forwarded-for is empty', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': ' , ', 'x-real-ip': '198.51.100.2' })))
      .toBe('198.51.100.2');
  });

  it('falls back to unknown when neither header is present', () => {
    expect(clientIpFromHeaders(headers({}))).toBe('unknown');
  });
});

describe('rateLimitKey', () => {
  it('namespaces buckets by route so one route cannot consume another quota', () => {
    expect(rateLimitKey('docs-chat', '203.0.113.7')).toBe('ratelimit:docs-chat:203.0.113.7');
    expect(rateLimitKey('docs-feedback', '203.0.113.7')).toBe('ratelimit:docs-feedback:203.0.113.7');
  });
});
