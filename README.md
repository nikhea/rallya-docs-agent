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

## Notes

- Knowledge is flagged **alpha** by Mastra: its API can change between releases, and its scopes are not yet a hard isolation boundary. That is fine here, since everything in it is public documentation.
- Memory stores conversations in the same Postgres database. History is bounded by a **token budget** (`MEMORY_MAX_TOKENS`, default 32000; `MEMORY_AT_MAX_REMOVE_TOKENS`, default 8000) instead of a message count, because one `knowledge_read` can add thousands of tokens. `generateTitle: true` names threads after their first question.

## Observability

Tracing and logging are configured in `src/mastra/index.ts`. The store follows `OBSERVABILITY_STORAGE`: DuckDB locally, Postgres in production.

- **Storage:** `MastraCompositeStore` with `PostgresStore` as the default domain (threads, messages, Knowledge). The observability domain (traces, logs, metrics, scores, feedback) is chosen by `OBSERVABILITY_STORAGE`:
  - `duckdb` (default): `DuckDBStore().observability`, an embedded file at `DUCKDB_PATH` (default `mastra.duckdb`). Good for local development.
  - `postgres`: `ObservabilityStoragePostgresVNext`, writing to its own schema (`OBSERVABILITY_SCHEMA`, default `mastra_observability`) and optionally its own database (`OBSERVABILITY_DATABASE_URL`, which defaults to `DATABASE_URL`). Set this in the deployed environment. For high-volume workloads, swap this domain for ClickHouse.
- **Why Postgres in production:** `POST /docs-feedback` calls `addFeedback()`, which rehydrates the target trace from observability storage before emitting the feedback event. A shared, durable store is what makes that lookup reliable after a redeploy or on another instance.
- **Partitions:** the v-next domain partitions by day. Without TimescaleDB or pg_partman it pre-creates yesterday through today + `OBSERVABILITY_PARTITION_FUTURE_DAYS` (default 30) on `init()`. Call `ensurePartitions()` from a scheduled job if a single instance runs longer than that window.
- **Tracing:** every run is sampled (`SamplingStrategyType.ALWAYS`), internal spans are kept (`includeInternalSpans`), and `SensitiveDataFilter` redacts API keys and tokens from span inputs/outputs before they are stored.
- **Logging:** `PinoLogger` writes every level at or above `LOG_LEVEL`; records are also exported into observability, and `loggerOptions.correlation` adds `trace_id`/`span_id` to log lines written inside a run, step or tool, so a stdout line points at its trace.
- **Reading them:** open Studio > Observability for the trace list and spans, or use the CLI:

  ```bash
  npx mastra api trace list '{"page":0,"perPage":20}'
  npx mastra api log list '{"level":"error","page":0,"perPage":50}'
  ```

  Both need the dev server running (`bun run dev`). With `OBSERVABILITY_STORAGE=postgres` you can also query the tables directly, e.g. `psql "$DATABASE_URL" -c 'select * from mastra_observability.span_events limit 5'`; with `duckdb` the data is in `mastra.duckdb`.

`LOG_PRETTY=false` switches the console to JSON lines for log aggregators.

- Pinned context needs Memory, which the agent has. The pinned listing shows the docs tree; raise `KNOWLEDGE_PINNED_MAX_TOKENS` to show deeper listings.
- `KNOWLEDGE_READ_MAX_TOKENS` caps each `knowledge_read` call (default 2000). Long pages are read in parts.
# rallya-docs-agent
