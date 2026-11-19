# rallya-docs-agent

A Mastra agent that answers questions about Rallya from the documentation that lives in Sanity (`rallya-docs`).

Knowledge is stored in PostgreSQL (with pgvector) and the agent gets **only the read tools**: it can search, list and read pages but never write them.

## How it fits together

```
Sanity (docPage / docSection)
        │  bun run sync          scripts/sync-sanity.ts
        ▼
Mastra Knowledge  "docs:rallya"  ← Postgres (PostgresStore) + pgvector
        │
        ▼
docs-agent: knowledge_list, knowledge_search, knowledge_read
        │
        ▼
traces + logs: DuckDB locally, Postgres in production, read in Studio > Observability
```

- `src/mastra/knowledge/index.ts`: the `Knowledge` instance: `docs:$siteId` scope, pinned docs tree, read-only tools, and the Sanity to Knowledge sync.
- `src/mastra/agents/docs-agent.ts`: the agent. It always runs with the `docs:rallya` scope, so Studio and API calls can read the docs without extra wiring.
- `src/mastra/instructions/doc.instructions.ts`: the system prompt, one exported block per concern (role, tasks, truth rules, knowledge sources, citation format, style, process, scope, rules) joined into `docInstructions`.
- `src/mastra/lib/sanity.ts`: Sanity client and the `docPage` / `docSection` queries.
- `scripts/sync-sanity.ts`: the sync CLI.
- `src/mastra/index.ts`: composite storage (Postgres app + DuckDB or Postgres observability), logging and tracing.

Each Sanity `docPage` becomes a page `docs:rallya#<slug>` (slashes flattened, so `api/keys` becomes `docs:rallya#api-keys`). Sections are summarised on `docs:rallya#docs-structure`. Bodies are the MDX from the Studio, verbatim.

## Setup

1. `cp .env.example .env` and fill in `SANITY_API_READ_TOKEN` (from `rallya-docs/.env.local`) and `GROQ_API_KEY`.
2. Create the database and enable pgvector:

   ```bash
   createdb rallya_docs_agent
   psql rallya_docs_agent -c 'create extension if not exists vector'
   ```

3. Embeddings default to a local Ollama model over its OpenAI-compatible endpoint (`EMBEDDER_URL=http://localhost:11434/v1`). Pull it once:

   ```bash
   ollama pull hf.co/unsloth/embeddinggemma-2-GGUF:Q8_0
   ```

   To use OpenAI instead: `EMBEDDER_PROVIDER_ID=openai EMBEDDER_MODEL_ID=openai/text-embedding-3-small` plus an OpenAI key. Knowledge cannot re-embed existing content, so change embedders before the first sync (or wipe the Knowledge tables).

4. Load the docs, then start Studio:

   ```bash
   bun run sync
   bun run dev        # http://localhost:4111, then Agents > docs-agent or Knowledge
   ```

## Re-syncing

`bun run sync` is safe to re-run: unchanged pages are skipped, so nothing is rewritten or re-embedded.

```bash
bun run sync -- --dry-run          # list what would be written
bun run sync -- --remove           # also prune pages deleted in Sanity
bun run sync -- --remove --force   # ... including pages that still have children
```

Run it after editors publish changes, or wire it to the Sanity webhook (`/api/sanity-revalidate` in `rallya-docs`) from your own job runner. `upsertPage()` is a host-only API: never expose the sync from an agent tool or an unauthenticated route.

### Automatic re-sync

Publishing from `rallya-docs` re-syncs Knowledge without a manual step:

```
merge to main (rallya-docs)
  → sync content/docs into Sanity → trigger the production deploy
  → repository_dispatch: docs-published
      → .github/workflows/sync-knowledge.yml (this repo, default branch)
          → bun run scripts/sync-sanity.ts --remove
```

- Only pages whose body changed are written: `upsertPage()` reports `unchanged` for everything else, so a publish does not re-upload the corpus.
- Pages deleted from Sanity are pruned; deletes are limited to pages authored by `sync:sanity`, so hand-authored Knowledge pages are untouched.
- Code-only pushes to `main` in `rallya-docs` publish nothing and do not dispatch, so no runner minutes are spent on a no-op.
- The workflow runs on the repository's **default branch**, so changes to it only take effect once merged to `main`.

Required repository secrets:

| Secret | Source |
| --- | --- |
| `DATABASE_URL` | PostgreSQL with pgvector (Neon `mute-sky-16638432`), pooled connection string |
| `SANITY_API_READ_TOKEN` | The same read token `rallya-docs` uses to build the site |

Run it by hand from Actions > **Knowledge sync** > *Run workflow*, or locally with `bun run sync -- --dry-run` first. A fresh run against an up-to-date Knowledge prints `0 created, 0 updated, N unchanged`.


## Auth

The server starts **unauthenticated** unless you set static API tokens — fine for a public-docs tool on your network, wrong for the open internet. `src/mastra/auth.ts` wires SimpleAuth from two env vars:

- `DOCS_AGENT_ADMIN_TOKEN` → admin user, `DOCS_AGENT_USER_TOKEN` → regular user

When at least one is set, everything under `/api/*` (agent generate, memory) and `/knowledge/*` requires the token. Studio pages load either way; the playground sends the token as `X-Playground-Access` once you paste it into its Access field (or sign in with the token as the password — the email is ignored).

```bash
export DOCS_AGENT_ADMIN_TOKEN=sk-admin-$(openssl rand -hex 16)
bun run dev
curl -X POST http://localhost:4111/api/agents/docs-agent/generate \
  -H "Authorization: Bearer $DOCS_AGENT_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"messages": "Hello"}'
```

## Public docs chat endpoint

`POST /docs-chat` streams the docs agent in AI SDK v7 UI-message format (SSE) so the docs site can offer anonymous Q&A. It is **unauthenticated by design**, even when SimpleAuth is configured — every other route remains protected.

```bash
curl -N -X POST http://localhost:4111/docs-chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"id": "m1", "role": "user", "parts": [{"type": "text", "text": "How do I get started?"}]}]}'
```

- Implementation: `src/mastra/routes/docs-chat.ts`, registered in `src/mastra/index.ts`.
- Built with Mastra's `chatRoute()` using AI SDK v7 stream parts, SSE heartbeats every 15 seconds, and a request logger.
- The start message's `metadata.traceId` carries the run's trace ID, so the docs client can attach feedback to the exact traced response.
- Route-level CORS handles browser preflights. Set `DOCS_CHAT_CORS_ORIGINS` to a comma-separated allowlist (for example `https://rallya-docs.vercel.app`); it defaults to `*` because the endpoint uses no cookies.
- The endpoint is public intentionally. Do not use it for private data or privileged actions.

### Feedback

`POST /docs-feedback` records thumbs, ratings or comments against a `/docs-chat` trace. Pass the `metadata.traceId` the client received on the stream's start part:

```bash
curl -X POST http://localhost:4111/docs-feedback \
  -H "Content-Type: application/json" \
  -d '{"traceId": "<trace-id>", "feedbackType": "comment", "value": "Very helpful"}'
```

Body fields: `traceId` (required), `spanId` (optional), `feedbackType` (default `thumbs`), `value` (number or string, required), `comment`, and `feedbackUserId`. It returns `200 {"success":true}`, `404` when the trace or span is not in observability storage, or `400` for a bad body.

Use this route rather than Studio's feedback box when the data must reach Mastra Platform. Studio's box writes straight to the runtime's observability store, which never reaches the Platform because it bypasses the observability event bus. `/docs-feedback` goes through `mastra.observability.addFeedback()` → `MastraPlatformExporter`, so the record appears in Studio and the Platform feedback API. See `src/mastra/routes/docs-feedback.ts`.

### Rate limits

Both public routes are rate limited with a Redis-backed **sliding window** shared by all replicas. Defaults are 10 requests/minute for `/docs-chat` and 15 for `/docs-feedback` (`DOCS_CHAT_RATE_LIMIT_MAX`, `DOCS_CHAT_RATE_LIMIT_WINDOW_MS` and the `DOCS_FEEDBACK_*` equivalents). Buckets are keyed by client IP and namespaced per route, so feedback traffic does not consume chat quota.

Every response from a limited route carries these headers:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Requests allowed per window for this bucket |
| `X-RateLimit-Remaining` | Requests left, floored at 0 |
| `X-RateLimit-Reset` | **Epoch seconds** when the current window ends (absolute time, not a delta) |
| `Retry-After` | **Delta seconds** until the caller may retry; only on a 429 |

They are listed in `Access-Control-Expose-Headers` on both routes, so a cross-origin docs client can read them. An over-quota request returns `429` with `{"error":"Too many requests","retryAfterSeconds":<number>}`; clients should honour `Retry-After` rather than guessing a backoff.

Two cases change the numbers in those headers:

- **Degraded mode:** if Redis is unavailable or a command times out, the limiter falls back to a bounded in-memory bucket at `max × RATE_LIMIT_FALLBACK_MULTIPLIER` (default 2x) **per instance**. `X-RateLimit-Limit` then reports the fallback limit — do not cache the limit from an earlier response.
- **Unknown client IP:** with `UNKNOWN_IP_POLICY=deny` (the default) the request is rejected with `X-RateLimit-Limit: 0` and a full-window `Retry-After`. With `strict`, all such callers share one small bucket (`UNKNOWN_IP_STRICT_MAX`, default 3).

Client IP comes from `CLIENT_IP_SOURCE` (`x-forwarded-for` by default, or `x-real-ip` / `cf-connecting-ip`). For `x-forwarded-for`, the limiter reads the entry `TRUSTED_PROXY_HOPS` positions from the **right** of the comma-separated chain and ignores the client-controlled left side. It validates the address, collapses IPv4-mapped IPv6 to IPv4, and folds IPv6 to a `/64` prefix — every host in one `/64` shares a bucket. Set `TRUSTED_PROXY_HOPS` for your edge (see the guidance in `.env.example`) before relying on per-IP limits. Configuration and the rollout decisions live in `.env.example` and `plan/rate-limit-hardening.md`.

## Notes

- Knowledge is flagged **alpha** by Mastra: its API can change between releases, and its scopes are not yet a hard isolation boundary. That is fine here, since everything in it is public documentation.
- Memory stores conversations in the same Postgres database. History is bounded by a **token budget** (`MEMORY_MAX_TOKENS`, default 32000; `MEMORY_AT_MAX_REMOVE_TOKENS`, default 8000) instead of a message count, because one `knowledge_read` can add thousands of tokens. `generateTitle: true` names threads after their first question.

## Observability

Tracing and logging are configured in `src/mastra/index.ts`. The store follows `OBSERVABILITY_STORAGE`: DuckDB locally, Postgres in production.

- **Storage:** `MastraCompositeStore` with `PostgresStore` as the default domain (threads, messages, Knowledge). The observability domain (traces, logs, metrics, scores, feedback) is chosen by `OBSERVABILITY_STORAGE`:
  - `duckdb` (default): `DuckDBStore().observability`, an embedded file at `DUCKDB_PATH` (default `mastra.duckdb`). Good for local development.
  - `postgres`: `ObservabilityStoragePostgresVNext`, writing to its own schema (`OBSERVABILITY_SCHEMA`, default `mastra_observability`) and optionally its own database (`OBSERVABILITY_DATABASE_URL`, which defaults to `DATABASE_URL`). Set this in the deployed environment. For high-volume workloads, swap this domain for ClickHouse.
- **Why Postgres in production:** `POST /docs-feedback` calls `addFeedback()`, which rehydrates the target trace from observability storage before emitting the feedback event. A shared, durable store is what makes that lookup reliable after a redeploy or on another instance.
- **Partitions:** the v-next domain partitions by day and is pinned to `partitioning: { mode: "native" }`, so it pre-creates yesterday through today + `OBSERVABILITY_PARTITION_FUTURE_DAYS` (default 30) on `init()`. pg_partman is installed on Neon but unusable there: its background worker runs as `pg_partman_bgw.role = postgres`, a role that does not exist, and the GUC is SUSET, so `partman.run_maintenance()` never creates anything. Nothing prunes old partitions yet; enable `pg_cron` in the Neon console (or add a job) if retention matters.
- **Platform export:** the config sets `retainStorageExporterOnPlatform: true`. Mastra Platform drops `MastraStorageExporter` by default when deploying, which leaves `getRecordedTrace()` with nothing to read and makes `/docs-feedback` return 404.
- **Tracing:** every run is sampled (`SamplingStrategyType.ALWAYS`), internal spans are kept (`includeInternalSpans`), and `SensitiveDataFilter` redacts API keys and tokens from span inputs/outputs before they are stored.
- **Logging:** `PinoLogger` writes every level at or above `LOG_LEVEL`; records are also exported into observability, and `loggerOptions.correlation` adds `trace_id`/`span_id` to log lines written inside a run, step or tool, so a stdout line points at its trace.
- **Rate-limit signals:** the limiter writes JSON log lines independently of Pino. Alert on `level:"error", event:"rate_limit_degraded"` (fields: `route`, `reason`, `counter`, and usually `error`) — emitted once per route on entering degraded mode, while every degraded request increments the in-process `rate_limit_degraded` counter. `rate_limit_unknown_ip` is a `warn` with `route`, `policy`, `count`, `counter`, sampled at the first occurrence and every 100th thereafter; alert on a sustained non-zero rate. `rate_limit_recovered` marks the return from degraded mode. `getRateLimitCounters()` in `src/mastra/routes/rate-limit.ts` returns per-route `{allowed, limited, degraded, unknownIp}` snapshots but is not exposed through an endpoint yet.
- **Reading them:** open Studio > Observability for the trace list and spans, or use the CLI:

  ```bash
  npx mastra api trace list '{"page":0,"perPage":20}'
  npx mastra api log list '{"level":"error","page":0,"perPage":50}'
  ```

  Both need the dev server running (`bun run dev`). With `OBSERVABILITY_STORAGE=postgres` you can also query the tables directly, e.g. `psql "$DATABASE_URL" -c 'select * from mastra_observability.mastra_span_events limit 5'`; with `duckdb` the data is in `mastra.duckdb`.

## Deploying

`mastra deploy --env production` reads `.env.<environment>` before `.env`, and pushes whatever it finds into the platform environment record. Because `.env` holds local-development values (notably `localhost` for `DATABASE_URL`), the repository keeps an intentional `.env.production` with no variables in it: production values live in the Mastra Platform environment record, and a deploy then leaves them untouched. Set or change them with `mastra env set` or the dashboard.

```bash
set -a && . ./.env && set +a
MASTRA_API_TOKEN="$MASTRA_PLATFORM_ACCESS_TOKEN" MASTRA_ORG_ID=<org> MASTRA_PROJECT_ID=<project> \
  npx mastra deploy --env production --project <project> --skip-preflight -y
```

`--skip-preflight` is needed with an empty env file: preflight treats every `process.env` reference as required from the file being deployed, even when the variable has a fallback or already exists on the environment.


`LOG_PRETTY=false` switches the console to JSON lines for log aggregators.

- Pinned context needs Memory, which the agent has. The pinned listing shows the docs tree; raise `KNOWLEDGE_PINNED_MAX_TOKENS` to show deeper listings.
- `KNOWLEDGE_READ_MAX_TOKENS` caps each `knowledge_read` call (default 2000). Long pages are read in parts.
# rallya-docs-agent
