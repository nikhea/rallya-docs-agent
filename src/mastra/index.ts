import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { PostgresStore } from "@mastra/pg";
import { DuckDBStore } from "@mastra/duckdb";
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
 * Composite storage: Postgres keeps threads, messages and Knowledge; DuckDB
 * keeps observability (traces, logs, metrics) in a local analytical file.
 * DuckDB is the recommended local-dev observability store — for production,
 * swap this domain for ClickHouse.
 */
const storage = new MastraCompositeStore({
  id: "rallya-docs-storage",
  // Default domain: threads, messages, workflows, agents.
  default: new PostgresStore({
    id: "rallya-docs-postgres",
    connectionString: databaseUrl,
  }),
  domains: {
    observability: new DuckDBStore({
      id: "rallya-docs-duckdb",
      path: duckdbPath,
    }).observability,
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
    // Also store log records in observability (DuckDB) for `mastra api log`.
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
