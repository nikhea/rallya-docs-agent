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
