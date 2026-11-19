/**
 * Redis-backed rate limiting for the public custom routes (`/docs-chat`,
 * `/docs-feedback`).
 *
 * Mastra has no built-in limiter. Route-level `middleware` runs in the Hono
 * handler chain even though these routes are `requiresAuth: false`; the global
 * `server.middleware` does not. Counters live in Redis so every replica shares
 * one bucket, and a key's TTL is the limit window.
 */
import Redis from 'ioredis';

import { rateLimitEnabled, redisUrl } from '../config';

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
  connecting ??= redis.connect().finally(() => {
    connecting = null;
  });
  try {
    await connecting;
    return true;
  } catch {
    return false;
  }
};

type HeaderGetter = (name: string) => string | undefined;

/**
 * Client IP for the rate bucket. Railway/Cloud Run set `x-forwarded-for`, whose
 * first entry is the original client; `x-real-ip` is the fallback. If the server
 * is ever exposed directly these headers are spoofable — use
 * `@hono/node-server`'s `getConnInfo()` there instead.
 */
export const clientIpFromHeaders = (getHeader: HeaderGetter): string => {
  const forwarded = getHeader('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = getHeader('x-real-ip')?.trim();
  return real || 'unknown';
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
 * `INCR` and the first-hit `PEXPIRE` run together so a key can never be left
 * without a TTL. Returns `[count, ttlMs]` to the caller.
 */
const WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

const warned = new Set<string>();
const warnOnce = (message: string, error?: unknown): void => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message, error ?? '');
};

/** Result used when the limiter is disabled or Redis is unavailable. */
const failOpen = (max: number): RateLimitResult => ({
  allowed: true,
  limit: max,
  remaining: max,
  retryAfterSeconds: 0,
  resetAtSeconds: Math.ceil(Date.now() / 1_000),
});

/**
 * Consume one request from a fixed-window bucket. Fail open on any Redis
 * problem: rate limiting protects the endpoint, it is not the endpoint.
 */
export const consumeRateLimit = async (
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> => {
  const redis = getRedisClient();
  if (!redis) return failOpen(max);
  if (!(await ensureRedisReady(redis))) {
    warnOnce('[rate-limit] Redis unavailable; allowing request');
    return failOpen(max);
  }

  try {
    const [rawCount, rawTtl] = await redis.eval(
      WINDOW_SCRIPT,
      1,
      key,
      String(windowMs),
    ) as [unknown, unknown];
    const count = Number(rawCount);
    const ttlMs = Math.max(0, Number(rawTtl));
    return {
      allowed: count <= max,
      limit: max,
      remaining: Math.max(0, max - count),
      retryAfterSeconds: Math.ceil(ttlMs / 1_000),
      resetAtSeconds: Math.ceil((Date.now() + ttlMs) / 1_000),
    };
  } catch (error) {
    warnOnce('[rate-limit] Redis error; allowing request', error);
    return failOpen(max);
  }
};
