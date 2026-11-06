import { fileURLToPath } from 'node:url';

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
 * DuckDB file for observability (traces, logs, metrics). DuckDB is embedded
 * and file-based; keep it on local disk, never on an ephemeral filesystem.
 * Resolved against the project root because the dev server's working
 * directory is `src/mastra/public`.
 */
export const duckdbPath = process.env.DUCKDB_PATH ?? fileURLToPath(new URL('../../mastra.duckdb', import.meta.url));

/** Console log level: debug | info | warn | error (Mastra's level set). */
export const logsLevel = (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

/** Pretty console output in development; JSON lines in production. */
export const logsPrettyPrint = process.env.LOG_PRETTY === undefined
  ? (process.env.NODE_ENV ?? 'development') !== 'production'
  : process.env.LOG_PRETTY === 'true';

/** Keep internal spans (model steps, memory, knowledge tools) in stored traces. */
export const traceIncludeInternalSpans = process.env.TRACE_INCLUDE_INTERNAL_SPANS !== 'false';
