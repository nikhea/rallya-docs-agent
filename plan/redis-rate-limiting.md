# Redis-backed rate limiting for public API routes

## Context

The Mastra server exposes two custom, unauthenticated routes registered via
`server.apiRoutes` in `src/mastra/index.ts`:

- `POST /docs-chat` — public docs Q&A (`src/mastra/routes/docs-chat.ts`)
- `POST /docs-feedback` — public feedback (`src/mastra/routes/docs-feedback.ts`)

Both are declared `requiresAuth: false`. Mastra has no built-in rate limiter.
The correct hook is **route-level middleware** (`middleware` on the `ApiRoute`),
which runs in the Hono handler chain before the handler. Mastra's *global*
`server.middleware` is explicitly skipped on `requiresAuth: false` routes, so it
would not protect these endpoints.

## Decisions

- Counter store: **Redis** via `REDIS_URL` and `ioredis` (shared across replicas, TTL-based expiry).
- Rate key: **client IP** (uniform for both routes, no body-parsing ordering issues). `visitor_id` can be layered in later for per-browser fairness behind NAT.
- Limits: **stricter** — 10 chat requests/min and 15 feedback requests/min per IP, configurable via env vars.
- Redis outage behavior: **fail open** (log a warning, allow the request) so a Redis failure does not take the docs chat down.
- Trusted proxy headers: Railway/Cloud Run set `x-forwarded-for`. If the server is ever exposed directly, switch to `@hono/node-server`'s `getConnInfo()`.

## 10 tasks / commits

- [x] **1. `docs(plan): add Redis rate limiting implementation plan`** — save this file with the breakdown.
- [x] **2. `chore(deps): add ioredis for Redis-backed rate limiting`** — add the dependency and update the lockfile.
- [ ] **3. `feat(config): add Redis and rate limit env configuration`** — `REDIS_URL`, `RATE_LIMIT_ENABLED`, chat + feedback limits/windows in `config.ts` and `.env.example`.
- [ ] **4. `feat(rate-limit): add lazy Redis client with fail-open guard`** — `getRedis()` singleton and enablement check in `src/mastra/routes/rate-limit.ts`.
- [ ] **5. `feat(rate-limit): add client IP key extraction`** — pure helpers for `x-forwarded-for` / `x-real-ip` / fallback and the `ratelimit:<name>:<ip>` key.
- [ ] **6. `feat(rate-limit): add atomic fixed-window counter`** — Lua `INCR` + `PEXPIRE` via `eval`, returning allowed/remaining/retry-after; fail open on Redis errors.
- [ ] **7. `feat(rate-limit): add route middleware with headers and 429`** — `X-RateLimit-*` headers, `Retry-After`, JSON 429 response.
- [ ] **8. `feat(routes): rate limit /docs-chat`** — put the limiter first in the route's middleware array.
- [ ] **9. `feat(routes): rate limit /docs-feedback`** — add the limiter to the route's middleware array.
- [ ] **10. `test(rate-limit): add helper unit tests and verify`** — `bun test` for pure helpers, `bun run typecheck`, and manual verification notes.

## Implementation details

### Config

- `REDIS_URL` — e.g. `redis://localhost:6379` locally, `rediss://…` for TLS in production.
- `RATE_LIMIT_ENABLED` — default `true`.
- `DOCS_CHAT_RATE_LIMIT_MAX` = `10`, `DOCS_CHAT_RATE_LIMIT_WINDOW_MS` = `60000`.
- `DOCS_FEEDBACK_RATE_LIMIT_MAX` = `15`, `DOCS_FEEDBACK_RATE_LIMIT_WINDOW_MS` = `60000`.
- If `RATE_LIMIT_ENABLED` is false or `REDIS_URL` is missing, skip rate limiting with a startup warning so local dev still works. Production must set `REDIS_URL`.

### Redis key and window

Key: `ratelimit:${name}:${clientIp}`. Atomic Lua script via `eval`:

```lua
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
```

Run `INCR` and `PEXPIRE` together so a key cannot be left without a TTL.

### Response behavior

- Set `X-RateLimit-Limit`, `X-RateLimit-Remaining` (`max(0, max - count)`), `X-RateLimit-Reset` (epoch seconds) on every limited response.
- On exceed (`count > max`) return `429` JSON with `Retry-After` = `ceil(ttlMs / 1000)`.
- On Redis errors, log a warning and call `next()` (fail open).

### Route wiring

- `docs-chat.ts`: `middleware: [rateLimit(chatLimits), requestLogger, visitorIdMemory]` — limiter first so blocked requests never get their JSON body parsed.
- `docs-feedback.ts`: `middleware: [rateLimit(feedbackLimits)]`.
- Keep `cors`, `requiresAuth: false`, and handlers unchanged.
- No change needed in `src/mastra/index.ts`.

## Verification

- `bun test` — helper unit tests.
- `bun run typecheck`.
- `bun run dev` with a local Redis (`docker run -p 6379:6379 redis`).
- Burst curl requests to both routes: first N succeed, rest return `429` with `Retry-After`, `X-RateLimit-*`, and CORS headers intact. Separate buckets per route.
- `redis-cli keys 'ratelimit:*'` / `ttl <key>` — keys expire after the window.
- Stop Redis — requests still succeed (fail-open path).

## Files touched

- `plan/redis-rate-limiting.md` — this plan and task checklist
- `package.json`, `bun.lock` — `ioredis`
- `src/mastra/config.ts`, `.env.example` — configuration
- `src/mastra/routes/rate-limit.ts` — new middleware and helpers
- `src/mastra/routes/rate-limit.test.ts` — unit tests
- `src/mastra/routes/docs-chat.ts`, `src/mastra/routes/docs-feedback.ts` — middleware wiring
