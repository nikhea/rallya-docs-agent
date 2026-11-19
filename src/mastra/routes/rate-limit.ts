/**
 * Redis-backed rate limiting for the public custom routes (`/docs-chat`,
 * `/docs-feedback`).
 *
 * Mastra has no built-in limiter. Route-level `middleware` runs in the Hono
 * handler chain even though these routes are `requiresAuth: false`; the global
 * `server.middleware` does not. Counters live in Redis so every replica shares
 * one bucket. A sliding window uses two short-lived keys per IP (current and
 * previous sub-window) weighted by elapsed time, removing the ~2x burst at a
 * fixed-window boundary.
 */
import type { MiddlewareHandler } from '@mastra/core/server';
import { isIP } from 'node:net';
import Redis from 'ioredis';

import {
  clientIpSource,
  rateLimitEnabled,
  rateLimitFallbackMultiplier,
  redisCommandTimeoutMs,
  redisUrl,
  trustedProxyHops,
  unknownIpPolicy,
  unknownIpStrictMax,
  type ClientIpSource,
} from '../config';

let client: Redis | null = null;
let connecting: Promise<void> | null = null;
let warnedNoUrl = false;

/** True when the limiter should run in this process. */
export const isRateLimitEnabled = (): boolean => {
  if (!rateLimitEnabled) return false;
  if (!redisUrl) {
    if (!warnedNoUrl) {
      console.warn('[rate-limit] REDIS_URL is not set; public route rate limiting is disabled');
      warnedNoUrl = true;
    }
    return false;
  }
  return true;
};

/**
 * Lazily create the shared Redis client. `lazyConnect` keeps module import free
 * of network side effects; `enableOfflineQueue: false` makes a dead Redis fail
 * fast instead of buffering commands until an unbounded reconnect.
 */
export const getRedisClient = (): Redis | null => {
  if (!isRateLimitEnabled()) return null;
  client ??= new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: redisCommandTimeoutMs,
    retryStrategy: times => Math.min(times * 200, 2_000),
  });
  return client;
};

/**
 * Ensure the singleton is connected before the first command. Concurrent
 * callers share one `connect()` promise so we never call it twice on a client
 * that is already connecting. Returns false on failure; callers fail open.
 */
export const ensureRedisReady = async (redis: Redis): Promise<boolean> => {
  if (redis.status === 'ready') return true;
  try {
    // connect() throws synchronously while ioredis is already connecting, so
    // keep it inside the try; any failure means degraded mode, never a 500.
    connecting ??= redis.connect().finally(() => {
      connecting = null;
    });
    await connecting;
    // Widen to string: TS narrows `redis.status` after the early return above,
    // but the await can change it back to 'ready'.
    return (redis.status as string) === 'ready';
  } catch {
    return false;
  }
};

type HeaderGetter = (name: string) => string | undefined;

/** Expand a compressed IPv6 address into eight hextets. */
const expandIpv6 = (ip: string): string[] | null => {
  if (ip.includes('%')) return null; // zone identifiers are not stable identities
  const [left = '', right = ''] = ip.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const missing = 8 - head.length - tail.length;
  const parts = [...head, ...Array<string>(Math.max(0, missing)).fill('0'), ...tail];
  return parts.length === 8 && parts.every(part => /^[0-9a-f]{1,4}$/i.test(part))
    ? parts
    : null;
};

/**
 * Validate an IP and reduce it to a stable bucket identity. IPv6 is folded to
 * its /64 prefix so one host cannot rotate through addresses within its prefix;
 * IPv4-mapped IPv6 addresses collapse to the IPv4 form.
 */
export const normalizeClientIp = (raw: string): string | null => {
  const value = raw.trim();
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
    if (mapped) return mapped[1];
    const parts = expandIpv6(value);
    if (!parts) return null;
    return `${parts.slice(0, 4).map(part => part.toLowerCase().padStart(4, '0')).join(':')}::/64`;
  }
  return null;
};

export type ClientIpOptions = {
  source: ClientIpSource;
  trustedProxyHops: number;
};

/**
 * Client IP for the rate bucket. Proxies differ: some overwrite
 * `x-forwarded-for` with the peer address, others append to whatever the client
 * sent. `trustedProxyHops` says how many trusted hops sit between the internet
 * and this process, so we take that many entries from the RIGHT of the chain —
 * never the attacker-controlled left side. Returns null when the chain is too
 * short or contains no valid IP; callers decide whether to deny or limit.
 */
export const clientIpFromHeaders = (
  getHeader: HeaderGetter,
  options: ClientIpOptions,
): string | null => {
  const raw = getHeader(options.source);
  if (!raw) return null;

  if (options.source === 'x-forwarded-for') {
    const entries = raw.split(',').map(entry => entry.trim());
    const index = entries.length - 1 - options.trustedProxyHops;
    return index >= 0 ? normalizeClientIp(entries[index] ?? '') : null;
  }
  return normalizeClientIp(raw);
};

/** Namespace buckets by route so feedback traffic can't consume chat quota. */
export const rateLimitKey = (name: string, ip: string): string => `ratelimit:${name}:${ip}`;

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets; 0 when not limited. */
  retryAfterSeconds: number;
  /** Epoch seconds when the current window resets. */
  resetAtSeconds: number;
};

/**
 * Sliding-window counter in one atomic script:
 *   KEYS[1] = previous sub-window, KEYS[2] = current sub-window
 *   ARGV    = [nowMs, windowMs, ttlMs]
 *
 * A request increments the current key. The estimate weights the previous
 * key's count by how much of that window remains. The estimate is returned as
 * a string because Redis truncates Lua numbers to integers on return.
 */
const WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local current = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
local prev = tonumber(redis.call('GET', KEYS[1]) or '0')

local elapsed = now % window
local estimate = current + prev * (1 - elapsed / window)
return { current, prev, tostring(estimate) }
`;

/**
 * Time until the sliding estimate drops to `max`, in milliseconds.
 * The estimate decreases linearly within the current sub-window, then the
 * current key becomes the "previous" key in the next sub-window.
 */
export const slidingRetryAfterMs = ({
  now,
  windowMs,
  current,
  prev,
  max,
}: {
  now: number;
  windowMs: number;
  current: number;
  prev: number;
  max: number;
}): number => {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const windowEnd = windowStart + windowMs;

  // Decay of the previous key inside the current window.
  if (prev > 0) {
    const t = windowMs * (1 - (max - current) / prev);
    if (Number.isFinite(t) && t >= 0 && now + t <= windowEnd) return t;
  }

  // Otherwise wait for the next window, where the current key becomes previous.
  const untilNext = windowEnd - now;
  if (current <= max) return Math.max(0, untilNext);

  const decay = windowMs * (1 - max / current);
  return Math.max(0, untilNext + (Number.isFinite(decay) ? decay : windowMs));
};

/** Per-route counters, readable by an admin/metrics endpoint if one is added. */
export type RateLimitCounters = {
  allowed: number;
  limited: number;
  degraded: number;
  unknownIp: number;
};
const counters = new Map<string, RateLimitCounters>();

/** Expose a snapshot without leaking the mutable map. */
export const getRateLimitCounters = (): Record<string, RateLimitCounters> => {
  const out: Record<string, RateLimitCounters> = {};
  for (const [route, value] of counters) out[route] = { ...value };
  return out;
};

const bump = (route: string, kind: keyof RateLimitCounters): void => {
  const current = counters.get(route) ?? { allowed: 0, limited: 0, degraded: 0, unknownIp: 0 };
  current[kind] += 1;
  counters.set(route, current);
};

/** Structured, sampled warning so a header-less flood cannot flood the logs. */
const unknownIpCounts = new Map<string, number>();
export const recordUnknownIp = (route: string): void => {
  const count = (unknownIpCounts.get(route) ?? 0) + 1;
  unknownIpCounts.set(route, count);
  bump(route, 'unknownIp');
  if (count === 1 || count % 100 === 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'rate_limit_unknown_ip',
        route,
        policy: unknownIpPolicy,
        count,
        counter: 'rate_limit_unknown_ip_total',
      }),
    );
  }
};

/** Result used only when limiting is explicitly disabled (no Redis / master off). */
const disabledResult = (max: number): RateLimitResult => ({
  allowed: true,
  limit: max,
  remaining: max,
  retryAfterSeconds: 0,
  resetAtSeconds: Math.ceil(Date.now() / 1_000),
});

/** Routes currently in degraded mode; used to log transitions once, not per request. */
const degradedRoutes = new Set<string>();
const markRecovered = (route: string): void => {
  if (!degradedRoutes.delete(route)) return;
  console.warn(
    JSON.stringify({ level: 'warn', event: 'rate_limit_recovered', route }),
  );
};

/**
 * Bounded in-memory fallback bucket. Redis is shared across replicas; this is
 * per instance, so with N replicas the effective limit is N × the fallback max.
 * We keep it well below that risk by capping the multiplier in config.
 */
type FallbackBucket = { count: number; resetAt: number };
const fallbackBuckets = new Map<string, FallbackBucket>();
const FALLBACK_MAX_KEYS = 10_000;
let lastFallbackSweep = 0;

const sweepFallbackBuckets = (now: number): void => {
  // Sweep at most once a second; the map is bounded anyway.
  if (now - lastFallbackSweep < 1_000) return;
  lastFallbackSweep = now;
  for (const [key, bucket] of fallbackBuckets) {
    if (bucket.resetAt <= now) fallbackBuckets.delete(key);
  }
};

/**
 * Degraded mode: still enforce a looser per-instance limit when Redis is down.
 * Emits an error-level structured log on the transition and counts every
 * degraded request so an alert can fire on a sustained non-zero rate.
 */
export const consumeFallback = (
  key: string,
  max: number,
  windowMs: number,
  route: string,
  reason: 'redis_unavailable' | 'redis_error',
  error?: unknown,
  now = Date.now(),
): RateLimitResult => {
  bump(route, 'degraded');
  if (!degradedRoutes.has(route)) {
    degradedRoutes.add(route);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'rate_limit_degraded',
        route,
        reason,
        counter: 'rate_limit_degraded_total',
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      }),
    );
  }

  const limit = Math.max(1, Math.floor(max * rateLimitFallbackMultiplier));
  sweepFallbackBuckets(now);

  let bucket = fallbackBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    // Map preserves insertion order: evict the oldest entry when full.
    if (fallbackBuckets.size >= FALLBACK_MAX_KEYS) {
      const oldest = fallbackBuckets.keys().next().value;
      if (oldest !== undefined) fallbackBuckets.delete(oldest);
    }
    bucket = { count: 0, resetAt: now + windowMs };
    fallbackBuckets.set(key, bucket);
  }
  bucket.count += 1;

  const ttlMs = Math.max(0, bucket.resetAt - now);
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.ceil(ttlMs / 1_000),
    resetAtSeconds: Math.ceil(bucket.resetAt / 1_000),
  };
};

/**
 * Consume one request from a fixed-window bucket. When Redis is unavailable the
 * limiter degrades to a bounded in-memory floor instead of opening completely.
 */
export const consumeRateLimit = async (
  key: string,
  max: number,
  windowMs: number,
  route = 'unknown',
): Promise<RateLimitResult> => {
  const redis = getRedisClient();
  if (!redis) return disabledResult(max);
  if (!(await ensureRedisReady(redis))) {
    return consumeFallback(key, max, windowMs, route, 'redis_unavailable');
  }

  try {
    const now = Date.now();
    const windowIndex = Math.floor(now / windowMs);
    const [rawCurrent, rawPrev, rawEstimate] = await redis.eval(
      WINDOW_SCRIPT,
      2,
      `${key}:w:${windowIndex - 1}`,
      `${key}:w:${windowIndex}`,
      String(now),
      String(windowMs),
      String(2 * windowMs),
    ) as [unknown, unknown, unknown];
    const current = Number(rawCurrent);
    const prev = Number(rawPrev);
    const parsedEstimate = Number(rawEstimate);
    const estimate = Number.isFinite(parsedEstimate) ? parsedEstimate : current;
    const allowed = estimate <= max;
    const retryAfterMs = allowed
      ? 0
      : slidingRetryAfterMs({ now, windowMs, current, prev, max });
    markRecovered(route);
    const result: RateLimitResult = {
      allowed,
      limit: max,
      remaining: Math.max(0, Math.floor(max - estimate)),
      retryAfterSeconds: Math.ceil(retryAfterMs / 1_000),
      // Epoch seconds when the current sub-window rolls over.
      resetAtSeconds: Math.ceil(((windowIndex + 1) * windowMs) / 1_000),
    };
    bump(route, allowed ? 'allowed' : 'limited');
    return result;
  } catch (error) {
    return consumeFallback(key, max, windowMs, route, 'redis_error', error);
  }
};

/** Options for a single route's limiter. */
export type RateLimitOptions = {
  /** Bucket namespace, normally the route name (e.g. `docs-chat`). */
  name: string;
  max: number;
  windowMs: number;
};

/**
 * Hono middleware for a Mastra `ApiRoute`. Put it first in the route's
 * `middleware` array so rejected requests never reach body parsing or the
 * agent. Route-level middleware runs even on `requiresAuth: false` routes;
 * global `server.middleware` does not.
 */
export const rateLimit = ({ name, max, windowMs }: RateLimitOptions): MiddlewareHandler =>
  async (c, next) => {
    const ip = clientIpFromHeaders(header => c.req.header(header), {
      source: clientIpSource,
      trustedProxyHops,
    });

    let result: RateLimitResult;
    if (!ip) {
      recordUnknownIp(name);
      if (unknownIpPolicy === 'deny') {
        bump(name, 'limited');
        result = {
          allowed: false,
          limit: 0,
          remaining: 0,
          retryAfterSeconds: Math.ceil(windowMs / 1_000),
          resetAtSeconds: Math.ceil((Date.now() + windowMs) / 1_000),
        };
      } else {
        // 'strict': same shared bucket, but far fewer requests per window.
        result = await consumeRateLimit(
          rateLimitKey(name, 'unknown'),
          Math.min(max, unknownIpStrictMax),
          windowMs,
          name,
        );
      }
    } else {
      result = await consumeRateLimit(rateLimitKey(name, ip), max, windowMs, name);
    }

    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    // Epoch seconds when the current sub-window rolls over.
    c.header('X-RateLimit-Reset', String(result.resetAtSeconds));

    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json(
        { error: 'Too many requests', retryAfterSeconds: result.retryAfterSeconds },
        429,
      );
    }
    return next();
  };
