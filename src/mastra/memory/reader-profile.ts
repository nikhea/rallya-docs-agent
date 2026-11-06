import { z } from "zod";

/**
 * Resource-scoped working memory profile for the Rallya docs agent.
 *
 * One small record per developer (keyed by `resourceId`, which the public
 * /docs-chat route sets from the `visitor_id` the client sends), shared by
 * every thread that visitor opens. It exists so the agent can spot
 * repeat searches, help with what is currently stuck, and tailor code
 * samples. It is not a log of conversations: the transcript lives in
 * message history and Observational Memory.
 *
 * Deliberately tiny, and search-focused: what they keep looking for, what
 * they are looking for right now, and what the docs never resolved for them.
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
  /** Topics they search the docs for most, most common first. Keep to ~5. */
  mostSearched: z.array(z.string()).optional(),
  /** What they are trying to find right now. Send [] once resolved. */
  currentSearches: z.array(z.string()).optional(),
  /** Questions the docs could not answer or the developer still did not understand. */
  unresolvedIssues: z.array(z.string()).optional(),
});

export type ReaderProfile = z.infer<typeof readerProfileSchema>;
