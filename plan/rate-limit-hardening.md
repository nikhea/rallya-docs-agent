# Rate limit hardening

Branch: `feat/rate-limit-hardening` (from `feat/redis-rate-limiting`).

## Context

The first pass (`plan/redis-rate-limiting.md`) added a Redis-backed fixed-window
limiter to the two public routes. Review found five issues worth fixing before
trusting it on an LLM-backed public endpoint. Fix order: **1, 3, 5, 9, 4** from
the review list.

## Decisions

- **Unknown IP**: default `deny` (fail closed), with `strict` as an opt-in that
  uses a much smaller bucket. Log structurally every time it happens.
- **Upstash REST client**: keep `src/mastra/lib/redis.ts` (`@upstash/redis`) and
  document that the limiter intentionally uses ioredis + the `rediss://` TCP URL.
- **Proxy hops**: default `TRUSTED_PROXY_HOPS=0` (take rightmost entry). Mastra
  Platform docs do not state whether the edge overwrites or appends
  `X-Forwarded-For`; Railway overwrites, Cloud Run appends. Verify with a canary
  (spoof a header against the deployed route and inspect the Redis key) before
  raising it to 1.
- Platform-agnostic identity: `CLIENT_IP_SOURCE` selects
  `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`. IPv6 normalized to /64.

## Tasks / commits

- [x] **0. `docs(plan): add rate limit hardening plan`** — save this file.
- [x] **1. `feat(rate-limit): derive client IP from trusted proxy hops`** — right-minus-N parsing, IP validation, IPv6 /64, `TRUSTED_PROXY_HOPS`, `CLIENT_IP_SOURCE`, unit tests.
- [x] **2. `feat(rate-limit): add degraded-mode in-memory floor and timeout`** — `commandTimeout: 200`, bounded in-memory fallback limiter, structured error log + `rate_limit_degraded_total` counter.
- [ ] **3. `feat(rate-limit): use a sliding-window counter`** — two weighted keys in one Lua script, deterministic window indices, `Math.ceil` retry-after, PTTL -1/-2 safety, epoch-seconds reset.
- [ ] **4. `feat(config): validate rate-limit env vars with zod`** — positive ints with bounds, boolean enum, URL check; throw on explicitly invalid values.
- [ ] **5. `feat(rate-limit): deny or strictly limit unknown client IPs`** — `UNKNOWN_IP_POLICY=deny|strict`, structured warning + counter, tests.
- [ ] **6. `docs(env): document new rate-limit vars and verify`** — `.env.example`, platform env record, `bun test`, `bun run typecheck`, `bun run build`, Redis smoke test.

## Deferred (not in this branch)

- Layered limits on `/docs-chat`: 100/hour per IP, per-`visitor_id`, global daily kill switch.
- Body/message length caps before the agent.
- Cloudflare Turnstile in front of `/docs-chat`.
- Testcontainers integration tests for Lua atomicity, reset, fail-open, 429 + CORS.
- Prove CORS headers on 429 in the deployed environment.

## Verification

Each task: `bun run typecheck` and `bun test`. Final: `bun run build`, local
Redis smoke test, and a check that the Mastra Platform env record has the new keys.
