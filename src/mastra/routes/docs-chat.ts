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
 *
 * Memory: a client that wants the agent to remember it across sessions sends
 * `visitor_id` in the JSON body (a stable id, e.g. a cookie or localStorage
 * value). `visitorIdMemory` below maps it to `memory: { resource }`, which
 * is what the agent's resource-scoped working memory keys off; an optional
 * `thread_id` becomes the conversation thread. Without `visitor_id` the
 * request runs exactly as before, stateless. An explicit `memory` object in
 * the body always wins over the `visitor_id` mapping.
 */
import { chatRoute } from "@mastra/ai-sdk";
import type { ApiRoute, MiddlewareHandler } from "@mastra/core/server";

import { docsChatCorsOrigins } from "../config";
import { isValidId } from "./ids";

/** SSE comment every 15s while the stream is idle (see withSseHeartbeat). */
const HEARTBEAT_MS = 15_000;

/**
 * Rewrite the cached body so the chatRoute handler parses the mutated
 * payload. Hono caches the raw body promise on `c.req.bodyCache` (typed as
 * resolved values, actually promises); replacing it is safe on the pinned
 * hono version and fails loudly in typecheck if the shape ever changes.
 */
const replaceCachedBody = (
  c: Parameters<MiddlewareHandler>[0],
  payload: Record<string, unknown>,
) => {
  (c.req as unknown as { bodyCache: unknown }).bodyCache = {
    text: Promise.resolve(JSON.stringify(payload)),
  };
};

/** One structured log line per request: method, path, status, duration. */
const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  console.log(
    `[docs-chat] ${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - start}ms`,
  );
};

/**
 * Maps `visitor_id` (+ optional `thread_id`) in the JSON body to
 * `memory: { resource[, thread] }` so resource-scoped working memory sticks
 * per visitor. Ids are removed from the body before it reaches the handler
 * so they never leak into the agent's stream options. On any parse problem
 * the body passes through untouched and the handler produces its usual
 * error. An explicit `memory` object in the body wins.
 */
const visitorIdMemory: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.header("content-type") ?? "";
  if (c.req.method !== "POST" || !contentType.includes("application/json")) {
    return next();
  }

  const text = await c.req.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: pass through; chatRoute answers with its own error.
    return next();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return next();
  }

  const payload = body as Record<string, unknown>;
  if (payload.visitor_id === undefined && payload.thread_id === undefined) {
    return next();
  }

  if (payload.visitor_id !== undefined && !isValidId(payload.visitor_id)) {
    return c.json(
      { error: "visitor_id must be a non-empty string of at most 128 characters" },
      400,
    );
  }
  if (payload.thread_id !== undefined && !isValidId(payload.thread_id)) {
    return c.json(
      { error: "thread_id must be a non-empty string of at most 128 characters" },
      400,
    );
  }

  const visitorId = (payload.visitor_id as string | undefined)?.trim();
  const threadId = (payload.thread_id as string | undefined)?.trim();
  if (threadId && !visitorId) {
    // Resource-scoped working memory would have no resourceId to key off;
    // fail fast instead of erroring mid-stream on the first memory write.
    return c.json({ error: "thread_id requires visitor_id" }, 400);
  }
  delete payload.visitor_id;
  delete payload.thread_id;

  if (payload.memory === undefined && visitorId) {
    payload.memory = { resource: visitorId, ...(threadId ? { thread: threadId } : {}) };
  }

  replaceCachedBody(c, payload);
  return next();
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
  middleware: [requestLogger, visitorIdMemory],
};
