import { z } from "zod";

/**
 * Resource-scoped working memory profile for the Rallya docs agent.
 *
 * One small, stable record per developer (keyed by `resourceId`), shared by
 * every thread that user opens. It exists so the agent can tailor code
 * samples, cite the right self-hosting page, and skip questions it already
 * has answered. It is not a log of conversations: the transcript lives in
 * message history and Observational Memory.
 *
 * Deliberately tiny. Anything the docs can answer is not a profile field.
 *
 * Merge semantics apply (schema-based working memory): the agent only sends
 * the fields it adds or changes, objects merge deep, arrays are replaced
 * wholesale, and setting a field to null deletes it. Postgres backs this via
 * @mastra/pg, which runs each merge in a row-locked transaction.
 */
export const readerProfileSchema = z.object({
  /** First name or nickname the developer goes by. */
  name: z.string().optional(),
  /** What they do, e.g. "backend engineer", "support", "solutions architect". */
  role: z.string().optional(),
  /** Preferred language/SDK for code samples: "typescript", "python", "go", ... */
  language: z.string().optional(),
  /** Where Rallya runs for them, e.g. "self-hosted on k8s, production". */
  environment: z.string().optional(),
  /** One line on what they are building or trying to do right now. */
  currentProject: z.string().optional(),
  /** Docs areas they keep coming back to, e.g. ["auth", "webhooks"]. */
  topics: z.array(z.string()).optional(),
});

export type ReaderProfile = z.infer<typeof readerProfileSchema>;
