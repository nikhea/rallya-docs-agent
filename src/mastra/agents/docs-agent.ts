import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";

import {
  agentModel,
  knowledgeScope,
  memoryAtMaxRemoveTokens,
  memoryMaxTokens,
} from "../config";
import { docInstructions } from "../instructions/doc.instructions";
import { docsKnowledge } from "../knowledge";
import { readerProfileSchema } from "../memory/reader-profile";
import { citationLinksProcessor } from "../processors/citation-links";
import {
  BatchPartsProcessor,
  PrefillErrorHandler,
  ProviderHistoryCompat,
  StreamErrorRetryProcessor,
  TokenLimiter,
  UnicodeNormalizer,
} from "@mastra/core/processors";
import { EnsureFinalResponseProcessor } from "../processors/ensure-final-response";

const MAX_STEPS = 10;
/**
 * Answers questions about Rallya from the documentation synced out of Sanity.
 *
 * Knowledge is attached with read-only tools (`knowledge_list`,
 * `knowledge_search`, `knowledge_read`) plus pinned context, so the agent
 * always starts with the docs tree in front of it. Memory is required for
 * pinned context and gives conversations a thread to live in. On top of
 * message history, the agent keeps a small resource-scoped working-memory
 * profile of the developer (see ../memory/reader-profile.ts), shared across
 * all of that user's threads.
 *
 * Instructions live in `../instructions/doc.instructions.ts`, one exported
 * block per concern (role, tasks, truth rules, knowledge sources, citation
 * format, and so on) joined into `docInstructions`.
 */
export const docsAgent = new Agent({
  id: "docs-agent",
  name: "Rallya Docs Agent",
  description:
    "Answers questions about Rallya using the official documentation.",
  instructions: docInstructions,
  // Chat model comes from DOCS_AGENT_MODEL (see ../config.ts); no hardcoding.
  model: agentModel,
  // Deterministic backstop: rewrite the bracketed page markers / bare Sources
  // lines the model sometimes emits into proper markdown links (see the file).
  inputProcessors: [
    new UnicodeNormalizer({
      stripControlChars: true,
      collapseWhitespace: true,
    }),
    new TokenLimiter(127000),
    new EnsureFinalResponseProcessor(MAX_STEPS),
  ],
  outputProcessors: [
    new BatchPartsProcessor({
      batchSize: 10,
      maxWaitTime: 100,
      emitOnNonText: true,
    }),
    citationLinksProcessor,
  ],
  errorProcessors: [
    new StreamErrorRetryProcessor(),
    new PrefillErrorHandler(),
    new ProviderHistoryCompat(),
  ],

  // Every run reads the docs scope, even when a caller (Studio, an API
  // request) doesn't pass scopes. A list is added to the run's own scopes.
  scopes: [knowledgeScope],
  knowledge: docsKnowledge,
  /**
   * Message history: recent turns are loaded with the thread (stored via the
   * Postgres storage on `Mastra`) and bounded by a token budget rather than a
   * message count — a single `knowledge_read` can be thousands of tokens.
   * System instructions, pinned context and the current turn are never trimmed.
   */
  memory: new Memory({
    options: {
      lastMessages:20,
      // Name threads after their first question, for the Studio thread list.
      generateTitle: {
        model: "openrouter/openrouter/free",
      },
      // messageHistory: {
      //   maxTokens: memoryMaxTokens,
      //   atMaxRemoveTokens: memoryAtMaxRemoveTokens,
      // },
      observationalMemory: {
        model: "cloudflare-workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
        temporalMarkers: true,
        activateAfterIdle: "5m",

        observation: {
          bufferOnIdle: true,
          activateAfterIdle: false,
          maxRetries: 8,
          failurePolicy: "continue",
          messageTokens: 10_000,
        },
        reflection: {
          activateAfterIdle: "10m",
          activateOnProviderChange: true,
          maxRetries: 8,
          failurePolicy: "continue",
          observationTokens: 30_000,
        },
      },
      /**
       * Working memory, resource scope: one small profile per developer
       * (name, role, preferred language, environment, current project,
       * recurring topics), shared by every thread that developer opens.
       * Schema-based, so the agent sends only the fields it is changing
       * and @mastra/pg merges them inside a row-locked transaction;
       * concurrent threads never clobber each other's fields. Backed by
       * the `mastra_resources` table in the same Postgres as the rest of
       * memory.
       *
       * Callers must pass `memory: { thread, resource }` or the profile
       * is unavailable (Studio does this automatically; the /docs-chat
       * client passes its user id as `resource`). resource is not shared
       * between users, so keep it per person, not per deployment.
       */
      workingMemory: {
        enabled: true,
        scope: "resource",
        schema: readerProfileSchema,
      },
    },
  }),
  errorProcessorDefaults: false,
  maxProcessorRetries: 5,
  defaultOptions: {
    maxSteps: MAX_STEPS,
    autoResumeSuspendedTools: true,
  },
});
