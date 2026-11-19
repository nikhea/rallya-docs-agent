import { Redis } from '@upstash/redis';

/**
 * Upstash Redis REST client for the project.
 *
 * Credentials come from UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * (see .env.example). The client is created lazily so importing this module
 * never throws when the variables are absent — e.g. in CI or a local checkout
 * that only runs the ioredis-backed rate limiter against a local Redis.
 */
let client: Redis | undefined;

export const getUpstashRedis = (): Redis => {
  client ??= Redis.fromEnv();
  return client;
};
