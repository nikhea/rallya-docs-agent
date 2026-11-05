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
traces + logs: DuckDB (mastra.duckdb), read in Studio > Observability
```

- `src/mastra/knowledge/index.ts`: the `Knowledge` instance: `docs:$siteId` scope, pinned docs tree, read-only tools, and the Sanity to Knowledge sync.
- `src/mastra/agents/docs-agent.ts`: the agent. It always runs with the `docs:rallya` scope, so Studio and API calls can read the docs without extra wiring.
- `src/mastra/instructions/doc.instructions.ts`: the system prompt, one exported block per concern (role, tasks, truth rules, knowledge sources, citation format, style, process, scope, rules) joined into `docInstructions`.
- `src/mastra/lib/sanity.ts`: Sanity client and the `docPage` / `docSection` queries.
- `scripts/sync-sanity.ts`: the sync CLI.
- `src/mastra/index.ts`: composite storage (Postgres + DuckDB), logging and tracing.

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

## Notes

- Knowledge is flagged **alpha** by Mastra: its API can change between releases, and its scopes are not yet a hard isolation boundary. That is fine here, since everything in it is public documentation.
- Memory stores conversations in the same Postgres database. History is bounded by a **token budget** (`MEMORY_MAX_TOKENS`, default 32000; `MEMORY_AT_MAX_REMOVE_TOKENS`, default 8000) instead of a message count, because one `knowledge_read` can add thousands of tokens. `generateTitle: true` names threads after their first question.
## Observability

Tracing and logging are configured in `src/mastra/index.ts` and store everything in DuckDB (`mastra.duckdb`), the recommended local-dev observability backend.

- **Storage:** `MastraCompositeStore` with `PostgresStore` as the default domain (threads, messages, Knowledge) and `DuckDBStore().observability` for traces, logs and metrics. For production, swap the DuckDB domain for ClickHouse; DuckDB is embedded and file-based.
- **Tracing:** every run is sampled (`SamplingStrategyType.ALWAYS`), internal spans are kept (`includeInternalSpans`), and `SensitiveDataFilter` redacts API keys and tokens from span inputs/outputs before they are stored.
- **Logging:** `PinoLogger` writes every level at or above `LOG_LEVEL`; records are also exported into observability, and `loggerOptions.correlation` adds `trace_id`/`span_id` to log lines written inside a run, step or tool, so a stdout line points at its trace.
- **Reading them:** open Studio > Observability for the trace list and spans, or use the CLI:

  ```bash
  npx mastra api trace list '{"page":0,"perPage":20}'
  npx mastra api log list '{"level":"error","page":0,"perPage":50}'
  ```

  Both need the dev server running (`bun run dev`). You can also query the file directly: `duckdb mastra.duckdb "select * from spans limit 5"`.

`LOG_PRETTY=false` switches the console to JSON lines for log aggregators.

- Pinned context needs Memory, which the agent has. The pinned listing shows the docs tree; raise `KNOWLEDGE_PINNED_MAX_TOKENS` to show deeper listings.
- `KNOWLEDGE_READ_MAX_TOKENS` caps each `knowledge_read` call (default 2000). Long pages are read in parts.
