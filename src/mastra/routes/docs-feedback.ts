/**
 * Public feedback endpoint for the docs agent.
 *
 * `POST /docs-feedback` records user feedback (thumbs, ratings, comments)
 * against the trace of a `/docs-chat` response. The docs client already
 * receives that trace's id on the start message (`metadata.traceId`), so it
 * only has to send it back here.
 *
 * Why not use Studio's built-in feedback box? On Mastra Cloud that box posts
 * to the deployed server's `POST /api/observability/feedback`, which calls
 * `storage.createFeedback()` directly. That is a storage-only write: it never
 * flows through the observability event bus, so `MastraPlatformExporter` never
 * forwards it to Mastra Platform. Studio, however, reads traces and feedback
 * from Mastra Platform. The result is a 200 on write and an empty list on read.
 *
 * `mastra.observability.addFeedback()` is the supported path: it rehydrates
 * the trace from observability storage (`MastraStorageExporter`), emits a
 * feedback event on the bus, and `MastraPlatformExporter` publishes it to the
 * Platform, where Studio can display it.
 */
import type { ApiRoute } from "@mastra/core/server";

import { docsChatCorsOrigins } from "../config";
import { isValidId } from "./ids";

/** Cap free-text values so a public caller can't push unbounded payloads. */
const MAX_TEXT_LENGTH = 2_000;

type FeedbackBody = {
  traceId?: unknown;
  spanId?: unknown;
  feedbackType?: unknown;
  value?: unknown;
  comment?: unknown;
  feedbackUserId?: unknown;
};

/** Truncate an optional free-text field; non-strings are dropped. */
const optionalText = (value: unknown, max = MAX_TEXT_LENGTH): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, max)
    : undefined;

export const docsFeedbackRoute: ApiRoute = {
  path: "/docs-feedback",
  method: "POST",
  // Public, like /docs-chat: anonymous docs readers leave feedback.
  requiresAuth: false,
  cors: {
    origin: docsChatCorsOrigins,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86_400,
  },
  createHandler: async ({ mastra }) => async c => {
    if (!mastra.observability.getRecordedTrace) {
      return c.json({ error: "Feedback is not supported by the active observability implementation" }, 501);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const payload = body as FeedbackBody;

    if (!isValidId(payload.traceId)) {
      return c.json({ error: "traceId must be a non-empty string of at most 128 characters" }, 400);
    }
    if (payload.spanId !== undefined && !isValidId(payload.spanId)) {
      return c.json({ error: "spanId must be a non-empty string of at most 128 characters" }, 400);
    }

    const feedbackType = optionalText(payload.feedbackType, 64) ?? "thumbs";
    // `value` is numeric for thumbs/ratings and free text for comments.
    const value = payload.value;
    if (typeof value !== "number" && typeof value !== "string") {
      return c.json({ error: "value must be a number or a string" }, 400);
    }
    if (typeof value === "string" && value.length > MAX_TEXT_LENGTH) {
      return c.json({ error: `value must be at most ${MAX_TEXT_LENGTH} characters` }, 400);
    }

    const comment = optionalText(payload.comment);
    const feedbackUserId = optionalText(payload.feedbackUserId, 128);

    // Rehydrate the trace from observability storage so a stale traceId fails
    // visibly instead of returning 200 while Mastra drops the event.
    const trace = await mastra.observability.getRecordedTrace({ traceId: payload.traceId.trim() });
    if (!trace) {
      return c.json({ error: "Unknown or expired traceId" }, 404);
    }
    const target = payload.spanId ? trace.getSpan(payload.spanId.trim()) : trace;
    if (!target) {
      return c.json({ error: "Unknown spanId" }, 404);
    }

    // Emits the feedback event; MastraPlatformExporter publishes it.
    await target.addFeedback({
      feedbackSource: "user",
      feedbackType,
      value,
      ...(comment ? { comment } : {}),
      ...(feedbackUserId ? { feedbackUserId } : {}),
    });

    return c.json({ success: true });
  },
};
