import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { DuckDBStore } from "@mastra/duckdb";
import {
  ObservabilityStoragePostgresVNext,
  PostgresStore,
} from "@mastra/pg";
import { MastraCompositeStore } from "@mastra/core/storage";
import { KNOWLEDGE_ROUTES } from "@mastra/server/server-adapter";
import {
  Observability,
  MastraStorageExporter,
  SensitiveDataFilter,
  MastraPlatformExporter,
} from "@mastra/observability";
import { SamplingStrategyType } from "@mastra/core/observability";

import {
  databaseUrl,
  duckdbPath,
  logsLevel,
  logsPrettyPrint,
  observabilityDatabaseUrl,
  observabilityPartitionFutureDays,
  observabilitySchema,
  observabilityStorage,
  traceIncludeInternalSpans,
} from "./config";
import { docsAgent } from "./agents/docs-agent";
import { docsKnowledge } from "./knowledge";
import { prewarmEmbedder } from "./prewarm";
import { authFromEnv } from "./auth";
import { weatherAgent } from "./agents/weather-agent";
import { customApiRoutes } from "./routes";

// Pay the embedding model's cold-start cost at boot, not at the first search.
prewarmEmbedder();

/**
 * Composite storage: Postgres keeps threads, messages and Knowledge.
 * Observability (traces, logs, metrics, scores, feedback) follows
 * `OBSERVABILITY_STORAGE`:
 *
 * - `duckdb` (default): an embedded file, right for local development.
 * - `postgres`: the v-next Postgres domain, right for production. It is
 *   durable, so `addFeedback()` can rehydrate the target trace after a
 *   restart or on another instance. For higher volume, swap it for ClickHouse.
 */
const observabilityDomain =
  observabilityStorage === "postgres"
    ? new ObservabilityStoragePostgresVNext({
        connectionString: observabilityDatabaseUrl,
        schemaName: observabilitySchema,
        partitioning: { futureDays: observabilityPartitionFutureDays },
      })
    : new DuckDBStore({
        id: "rallya-docs-duckdb",
        path: duckdbPath,
      }).observability;

// `NODE_ENV` is not trustworthy here: the local `.env` sets it to `production`.
// Warn only on the markers the real deployments actually set (Cloud Run and
// Railway), so local `bun run dev` stays quiet.
const deployed = Boolean(process.env.K_SERVICE ?? process.env.RAILWAY_ENVIRONMENT);
if (deployed && observabilityStorage === "duckdb") {
  console.warn(
    "[observability] OBSERVABILITY_STORAGE is not postgres. Traces and feedback will not survive restarts, and POST /docs-feedback cannot rehydrate traces.",
  );
}

const storage = new MastraCompositeStore({
  id: "rallya-docs-storage",
  // Default domain: threads, messages, workflows, agents.
  default: new PostgresStore({
    id: "rallya-docs-postgres",
    connectionString: databaseUrl,
  }),
  domains: {
    observability: observabilityDomain,
  },
});

export const mastra = new Mastra({
  agents: { docsAgent, weatherAgent },
  knowledge: { docs: docsKnowledge },
  storage,
  // Serves /knowledge/* so the pages show up under Knowledge in Studio.
  // Auth is enabled when DOCS_AGENT_ADMIN_TOKEN / DOCS_AGENT_USER_TOKEN are
  // set (see ./auth.ts); otherwise the server starts without auth.
  // `customApiRoutes` exposes the public, unauthenticated /docs-chat endpoint.
  server: { apiRoutes: [...KNOWLEDGE_ROUTES, ...customApiRoutes], auth: authFromEnv() },
  logger: new PinoLogger({
    name: "rallya-docs-agent",
    level: logsLevel,
    // JSON lines (with trace_id/span_id) when not pretty-printing.
    prettyPrint: logsPrettyPrint,
  }),
  loggerOptions: {
    // Adds trace_id/span_id to every log line written inside a run/step/tool,
    // so a stdout line can be matched to its trace in Studio.
    correlation: true,
    // Also store log records in observability for `mastra api log`.
    export: true,
  },
  observability: new Observability({
    configs: {
      default: {
        serviceName: "rallya-docs-agent",
        // Sample every trace: this is a low-traffic docs assistant.
        sampling: { type: SamplingStrategyType.ALWAYS },
        logging: {
          enabled: true,
          level: logsLevel,
        },
        exporters: [new MastraStorageExporter(),new MastraPlatformExporter()],
        // Include every internal span (model steps, memory, knowledge tool
        // calls) when reading a trace.
        // includeInternalSpans: traceIncludeInternalSpans,
        // Redact API keys and tokens from span inputs/outputs before storage.
        spanOutputProcessors: [new SensitiveDataFilter()],
      },

    },
  }),
});
