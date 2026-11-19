import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Environment-backed configuration for the docs agent.
 *
 * Everything here is read lazily at module load; values that are missing fall
 * back to the local defaults documented in `.env.example`.
 */

/** PostgreSQL (with the pgvector extension) holds both Mastra storage and the Knowledge vectors. */
export const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://admin:adminpassword@localhost:5432/rallya_docs_agent';

/**
 * Scope that holds the Rallya docs, e.g. `docs:rallya`. Every page synced from
 * Sanity lives under `<knowledgeScope>#<page path>`.
 */
export const knowledgeScope = process.env.KNOWLEDGE_SCOPE ?? 'docs:rallya';

/** Embedding model used for semantic search. Must be on the Mastra model router. */
export const embedderModel = process.env.KNOWLEDGE_EMBEDDER ?? 'openai/text-embedding-3-small';

/** Chat model for the docs agent. Override for cheaper/faster models. */
export const agentModel = process.env.DOCS_AGENT_MODEL ?? 'ollama-cloud/gpt-oss:120b';

/**
 * Embedding model for semantic search. Defaults to a local Ollama server over
 * its OpenAI-compatible endpoint, so the docs never leave the machine and no
 * third-party embedding key is needed. Any OpenAI-compatible endpoint works.
 */
export const embedder = {
  providerId: process.env.EMBEDDER_PROVIDER_ID ?? 'ollama',
  modelId: process.env.EMBEDDER_MODEL_ID ?? 'hf.co/unsloth/embeddinggemma-2-GGUF:Q8_0',
  url: process.env.EMBEDDER_URL ?? 'http://localhost:11434/v1',
  // Ollama ignores the key but the OpenAI client requires one to be set.
  apiKey: process.env.EMBEDDER_API_KEY ?? 'not-needed',
};

/**
 * Optional canonical URL of the docs site. When set, page bodies get a
 * "Source:" footer so the agent can link people to the live page.
 */
export const docsBaseUrl = process.env.DOCS_BASE_URL?.replace(/\/+$/, '');

/**
 * Origins allowed to call the public `POST /docs-chat` endpoint. Comma-separated;
 * defaults to `*` because the route is unauthenticated and sets no cookies.
 * Set e.g. `https://rallya-docs.vercel.app` to restrict browser callers.
 */
export const docsChatCorsOrigins = ((): string | string[] => {
  const configured = process.env.DOCS_CHAT_CORS_ORIGINS?.split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  return configured && configured.length > 0 ? configured : '*';
})();

/** How many `knowledge_read` tokens the agent gets per call (see the Knowledge limits docs). */
export const readMaxTokens = Number(process.env.KNOWLEDGE_READ_MAX_TOKENS ?? 2000);

/** Tokens reserved for pinned context on every turn. */
export const pinnedMaxTokens = Number(process.env.KNOWLEDGE_PINNED_MAX_TOKENS ?? 700);

/**
 * Token budget for conversation history (prompt + remembered messages +
 * the current turn). Long docs pages make message counts a poor proxy for
 * context size, so history is bounded by tokens instead of `lastMessages`.
 */
export const memoryMaxTokens = Number(process.env.MEMORY_MAX_TOKENS ?? 32_000);

/** Tokens freed at once when the history budget is exceeded (keeps the prompt prefix stable). */
export const memoryAtMaxRemoveTokens = Number(process.env.MEMORY_AT_MAX_REMOVE_TOKENS ?? 8_000);

/**
 * Where observability data (traces, logs, metrics, scores and feedback) lives.
 *
 * - `duckdb` (default): embedded file, ideal for local development.
 * - `postgres`: `ObservabilityStoragePostgresVNext`, for production. Traces
 *   survive restarts and every instance shares one store, which is what makes
 *   `addFeedback()` able to rehydrate a trace by id.
 *
 * Set `OBSERVABILITY_STORAGE=postgres` in the deployed environment.
 */
export const observabilityStorage =
  process.env.OBSERVABILITY_STORAGE === 'postgres' ? 'postgres' as const : 'duckdb' as const;

/**
 * DuckDB file used when `observabilityStorage` is `duckdb`. DuckDB is embedded
 * and file-based; keep it on local disk, never on an ephemeral filesystem.
 * Resolved against the project root because the dev server's working
 * directory is `src/mastra/public`.
 */
export const duckdbPath = process.env.DUCKDB_PATH ?? fileURLToPath(new URL('../../mastra.duckdb', import.meta.url));

/**
 * Postgres connection used when `observabilityStorage` is `postgres`.
 * Defaults to `DATABASE_URL` so the switch needs one variable, but production
 * should point this at a dedicated database/branch: the v-next domain is
 * append-only and write-heavy, and sharing it with the app database degrades
 * query latency.
 */
export const observabilityDatabaseUrl =
  process.env.OBSERVABILITY_DATABASE_URL ?? databaseUrl;

/** Schema inside the observability database that holds the signal tables. */
export const observabilitySchema =
  process.env.OBSERVABILITY_SCHEMA ?? 'mastra_observability';

/**
 * Days of daily partitions to pre-create. The Postgres observability domain
 * partitions by day; without TimescaleDB or pg_partman it pre-creates
 * yesterday through today + N days on init(), and extends on demand inside
 * that window. Re-init happens on every deploy; call `ensurePartitions()` from
 * a scheduled job if a single instance runs longer than this window.
 */
export const observabilityPartitionFutureDays = Number(
  process.env.OBSERVABILITY_PARTITION_FUTURE_DAYS ?? 30,
);

/** Console log level: debug | info | warn | error (Mastra's level set). */
export const logsLevel = (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

/** Pretty console output in development; JSON lines in production. */
export const logsPrettyPrint = process.env.LOG_PRETTY === undefined
  ? (process.env.NODE_ENV ?? 'development') !== 'production'
  : process.env.LOG_PRETTY === 'true';

/** Keep internal spans (model steps, memory, knowledge tools) in stored traces. */
export const traceIncludeInternalSpans = process.env.TRACE_INCLUDE_INTERNAL_SPANS !== 'false';

/* -------------------------------------------------------------------------- */
/* Rate-limit configuration (validated with zod)                              */
/* -------------------------------------------------------------------------- */

/** Missing or blank env values use the default; present-but-invalid throws. */
const present = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const intInRange = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

export const rateLimitEnvSchema = z.object({
  REDIS_URL: z.string().refine(
    value => value === '' || /^rediss?:\/\//i.test(value),
    'REDIS_URL must start with redis:// or rediss:// (or be empty to disable)',
  ),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']),
  CLIENT_IP_SOURCE: z.enum(['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']),
  TRUSTED_PROXY_HOPS: intInRange(0, 5),
  REDIS_COMMAND_TIMEOUT_MS: intInRange(50, 2_000),
  RATE_LIMIT_FALLBACK_MULTIPLIER: intInRange(1, 10),
  DOCS_CHAT_RATE_LIMIT_MAX: intInRange(1, 1_000),
  DOCS_CHAT_RATE_LIMIT_WINDOW_MS: intInRange(1_000, 86_400_000),
  DOCS_FEEDBACK_RATE_LIMIT_MAX: intInRange(1, 1_000),
  DOCS_FEEDBACK_RATE_LIMIT_WINDOW_MS: intInRange(1_000, 86_400_000),
});

const rateLimitEnv = (() => {
  const result = rateLimitEnvSchema.safeParse({
    REDIS_URL: process.env.REDIS_URL?.trim() ?? '',
    RATE_LIMIT_ENABLED: present('RATE_LIMIT_ENABLED') ?? 'true',
    CLIENT_IP_SOURCE: present('CLIENT_IP_SOURCE') ?? 'x-forwarded-for',
    TRUSTED_PROXY_HOPS: present('TRUSTED_PROXY_HOPS') ?? '0',
    REDIS_COMMAND_TIMEOUT_MS: present('REDIS_COMMAND_TIMEOUT_MS') ?? '200',
    RATE_LIMIT_FALLBACK_MULTIPLIER: present('RATE_LIMIT_FALLBACK_MULTIPLIER') ?? '2',
    DOCS_CHAT_RATE_LIMIT_MAX: present('DOCS_CHAT_RATE_LIMIT_MAX') ?? '10',
    DOCS_CHAT_RATE_LIMIT_WINDOW_MS: present('DOCS_CHAT_RATE_LIMIT_WINDOW_MS') ?? '60000',
    DOCS_FEEDBACK_RATE_LIMIT_MAX: present('DOCS_FEEDBACK_RATE_LIMIT_MAX') ?? '15',
    DOCS_FEEDBACK_RATE_LIMIT_WINDOW_MS: present('DOCS_FEEDBACK_RATE_LIMIT_WINDOW_MS') ?? '60000',
  });
  if (result.success) return result.data;
  const details = result.error.issues
    .map(issue => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`[config] Invalid rate-limit environment variables: ${details}`);
})();

/**
 * Redis connection used for the public route rate-limit counters. Shared across
 * replicas, so one limit applies to the whole deployment. Empty means local dev
 * without Redis: the limiter is skipped with a warning (see routes/rate-limit.ts).
 */
export const redisUrl = rateLimitEnv.REDIS_URL;

/** Master switch for public route rate limiting. Default: enabled. */
export const rateLimitEnabled = rateLimitEnv.RATE_LIMIT_ENABLED === 'true';

/** Header carrying the client IP. See routes/rate-limit.ts for trust rules. */
export type ClientIpSource = z.infer<typeof rateLimitEnvSchema>['CLIENT_IP_SOURCE'];
export const clientIpSource = rateLimitEnv.CLIENT_IP_SOURCE;

/**
 * Number of trusted proxies between the internet and this process. For an
 * appending proxy, the client is `hops` entries from the right; for a proxy
 * that overwrites X-Forwarded-For, leave this at 0.
 */
export const trustedProxyHops = rateLimitEnv.TRUSTED_PROXY_HOPS;

/**
 * Redis command timeout. A slow Redis must not add latency to a public route;
 * on timeout the limiter drops into its in-memory degraded mode.
 */
export const redisCommandTimeoutMs = rateLimitEnv.REDIS_COMMAND_TIMEOUT_MS;

/**
 * Multiplier for the in-memory fallback limit while Redis is unavailable. The
 * floor is looser than the Redis limit (N replicas each get their own bucket)
 * but still protects the LLM endpoint during an outage.
 */
export const rateLimitFallbackMultiplier = rateLimitEnv.RATE_LIMIT_FALLBACK_MULTIPLIER;

/** Stricter defaults for the unauthenticated LLM chat endpoint. */
export const docsChatRateLimitMax = rateLimitEnv.DOCS_CHAT_RATE_LIMIT_MAX;
export const docsChatRateLimitWindowMs = rateLimitEnv.DOCS_CHAT_RATE_LIMIT_WINDOW_MS;

/** Feedback is a cheap write, but still rate limited to stop abuse. */
export const docsFeedbackRateLimitMax = rateLimitEnv.DOCS_FEEDBACK_RATE_LIMIT_MAX;
export const docsFeedbackRateLimitWindowMs = rateLimitEnv.DOCS_FEEDBACK_RATE_LIMIT_WINDOW_MS;
