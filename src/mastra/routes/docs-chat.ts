/**
 * Public chat endpoint for the docs agent.
 *
 * `POST /docs-chat` streams the agent in AI SDK v7 UI-message format (SSE).
 * It is the route the docs site calls for anonymous Q&A, so it is
 * **unauthenticated by design** — even when SimpleAuth is configured, this
 * route opts out via `requiresAuth: false`. Everything else on the server
 * stays protected.
 *
 * Built on `chatRoute()` from `@mastra/ai-sdk` — the same machinery as
 * Mastra's built-in agent streaming routes: AI SDK v7 wire format, SSE
 * heartbeats so proxies don't drop long reasoning bursts, and OpenAPI
 * metadata. `chatRoute()` doesn't accept `requiresAuth` / `cors` /
 * `middleware`, so those are layered on afterwards.
 */
import { chatRoute } from "@mastra/ai-sdk";
import type { ApiRoute, MiddlewareHandler } from "@mastra/core/server";

import { docsChatCorsOrigins } from "../config";

/** SSE comment every 15s while the stream is idle (see withSseHeartbeat). */
const HEARTBEAT_MS = 15_000;

/** One structured log line per request: method, path, status, duration. */
const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  console.log(
    `[docs-chat] ${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - start}ms`,
  );
};

const base = chatRoute({
  path: "/docs-chat",
  // The agent's `id` (see src/mastra/agents/docs-agent.ts); getAgentById()
  // matches it regardless of the registry key.
  agent: "docs-agent",
  version: "v7",
  heartbeatMs: HEARTBEAT_MS,
  // Put the run's traceId on the start message part so the docs client can
  // attach feedback to this exact traced response later.
  messageMetadata: ({ part, traceId }) =>
    part.type === "start" ? { traceId } : undefined,
});

export const docsChatRoute: ApiRoute = {
  ...base,
  // Public: SimpleAuth is skipped for this route (see src/mastra/index.ts).
  requiresAuth: false,
  // Route-level CORS. Applied by the server before auth, including OPTIONS
  // preflights, via hono/cors. Origins from DOCS_CHAT_CORS_ORIGINS (default *).
  cors: {
    origin: docsChatCorsOrigins,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86_400,
  },
  middleware: [requestLogger],
};
