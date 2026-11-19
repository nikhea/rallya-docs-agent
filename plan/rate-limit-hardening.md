# Rate limit hardening

Branch: `feat/rate-limit-hardening` (from `feat/redis-rate-limiting`).

## Context

The first pass (`plan/redis-rate-limiting.md`) added a Redis-backed fixed-window
limiter to the two public routes. Review found five issues worth fixing before
trusting it on an LLM-backed public endpoint. Fix order: **1, 3, 5, 9, 4** from
the review list.

## Decisions

- **Unknown IP**: default `deny` (fail closed), with `strict` as an opt-in that
  uses a much smaller bucket. Count every event; emit the structured warning at
  the first occurrence per route and every 100th thereafter.
- **Upstash REST client**: keep `src/mastra/lib/redis.ts` (`@upstash/redis`) and
  document that the limiter intentionally uses ioredis + the `rediss://` TCP URL.
- **Proxy hops**: default `TRUSTED_PROXY_HOPS=0` (take rightmost entry). `N`
  counts trusted proxies that *append* their peer to `X-Forwarded-For` between
  the client and this process, not proxies that overwrite it. A single edge that
  overwrites or appends still leaves the real client at the rightmost position,
  so `N=0` is correct there; add one per extra appending hop. Mastra Platform
  docs do not state which behaviour its edge uses; Railway overwrites, Cloud Run
  appends. Verify with a canary (spoof a header against the deployed route and
  inspect the Redis key) before raising it to 1.
- Platform-agnostic identity: `CLIENT_IP_SOURCE` selects
  `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`. IPv6 normalized to /64.

## Tasks / commits

- [x] `2953044` — `docs(plan): add rate limit hardening plan` (this file).
- [x] `75cc11f` — review item 1, `derive client IP from trusted proxy hops`: right-minus-N parsing, IP validation, IPv6 /64, `TRUSTED_PROXY_HOPS`, `CLIENT_IP_SOURCE`, unit tests.
- [x] `d17bf21` — review item 3, `add degraded-mode in-memory floor and timeout`: `commandTimeout: 200`, bounded fallback limiter, structured error log + `rate_limit_degraded_total` counter, connect-guard fix.
- [x] `19ffcf5` — review item 5, `use a sliding-window counter`: two weighted keys in one Lua script, deterministic window indices, `Math.ceil` retry-after, PTTL -1/-2 safety, epoch-seconds reset.
- [x] `b55502d` — review item 9, `validate rate-limit env vars with zod`: bounded ints, enums, URL check; missing values default, invalid values fail startup.
- [x] `250fd94` — review item 4, `deny or strictly limit unknown client IPs`: `UNKNOWN_IP_POLICY=deny|strict`, sampled structured warning + counter, tests.
- [x] `4e706f2` — `docs(env): document hardened rate-limit vars and verify`: `.env.example`, platform env record, verification notes.

## Deferred (not in this branch)

- Layered limits on `/docs-chat`: 100/hour per IP, per-`visitor_id`, global daily kill switch.
- Body/message length caps before the agent.
- Cloudflare Turnstile in front of `/docs-chat`.
- Testcontainers integration tests for Lua atomicity, reset, fail-open, 429 + CORS.
- Prove CORS headers on 429 in the deployed environment (the routes now set
  `exposeHeaders` for the four rate-limit headers; the deployed response is
  still unverified).

## Verification

Each task: `bun run typecheck` and `bun test`. Final: `bun run build`, local
Redis smoke test, and a check that the Mastra Platform env record has the new keys.

## Results

- 22 unit tests pass; typecheck clean (23 files); `bun run build` successful.
- Real Redis Lua smoke test: sliding keys with index + 2x-window PTTL, 2 allowed
  then 429 on the 3rd, `Retry-After` and `X-RateLimit-*` headers present.
- `TRUSTED_PROXY_HOPS=1` canary: a spoofed left `X-Forwarded-For` entry was
  ignored; the Redis key used the real IP from the right-minus-1 position.
- `UNKNOWN_IP_POLICY=strict` smoke test: max 3, 3 allowed then 429; structured
  `rate_limit_unknown_ip` warning emitted.
- Startup with `DOCS_CHAT_RATE_LIMIT_MAX=0` throws a clear zod error.
- Mastra Platform env record now has 42 vars (was 36); all 14 rate-limit/Redis
  keys present and all pre-existing values preserved.

Still required after deploy: confirm whether the edge overwrites or appends
`X-Forwarded-For`, then adjust `TRUSTED_PROXY_HOPS`. Also alert on the
`rate_limit_degraded` error log and `rate_limit_unknown_ip` warning.

## Documentation follow-up

- `README.md` now documents the full header/429 contract, degraded-mode and
  unknown-IP effects on those headers, client-IP derivation, and the
  rate-limit log events to alert on.
- `.env.example` now explains which single IP header is trusted, what
  `TRUSTED_PROXY_HOPS` counts (with the canary requirement), IPv6 `/64`
  sharing, the sampled unknown-IP warning, and the degraded-mode footprint.
- Both public routes set `exposeHeaders` for `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Retry-After` so a
  cross-origin docs client can read them. Deployed CORS behaviour is still
  listed as deferred above.
- This plan's task list now maps to the actual commit hashes, and the logging
  decision matches the sampled implementation.
