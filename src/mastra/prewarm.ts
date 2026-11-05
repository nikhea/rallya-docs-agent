import { ModelRouterEmbeddingModel } from '@mastra/core/llm';

import { embedder } from './config';

let warmed = false;

/**
 * Ollama loads the embedding model into memory on the first embed call
 * (measured ~3.7s), which used to land on the first `knowledge_search` of the
 * day. Fire one embedding at boot instead. Best-effort: a failure here only
 * means the first search pays the cost, as before.
 *
 * Set PREWARM_EMBEDDER=false to skip (e.g. when the embedder is unreachable).
 */
export function prewarmEmbedder(): void {
  if (warmed || process.env.PREWARM_EMBEDDER === 'false') return;
  warmed = true;
  const started = Date.now();
  new ModelRouterEmbeddingModel(embedder)
    .doEmbed({ values: ['rallya docs warmup'] })
    .then(() => console.log(`[prewarm] embedder ready (${Date.now() - started}ms)`))
    .catch((error: unknown) => {
      // Never fail server startup over a warm-up.
      console.warn('[prewarm] embedder warm-up failed:', error instanceof Error ? error.message : error);
    });
}
