/**
 * Deterministic backstop for the citation format the model keeps breaking.
 *
 * The instructions ask for markdown links whose text is the page title, but
 * the model sometimes emits its own fullwidth-bracketed marker
 * (`【Page#heading-slug】`) and bare `Sources:` lines. The instructions are the
 * first line of defense; this processor makes the output correct regardless of
 * what the model does, in two places:
 *
 * - `processOutputStream` rewrites text-delta chunks as they stream. A
 *   hold-back buffer keeps a trailing incomplete marker (or open `Sources:`
 *   line) un-emitted until the rest of it arrives, so a marker split across
 *   chunks is rewritten whole instead of leaking half of it.
 * - `processOutputResult` rewrites the stored assistant messages before they
 *   are saved, so the conversation history (and future turns reading it)
 *   shows the same corrected citations.
 *
 * Page name -> docs URL resolution uses the Knowledge page store: every
 * synced page carries the live URL in its body footer, and its flat key is
 * unique. When the lookup fails or the docs URL is unknown, a marker degrades
 * to the page name as plain text — never to a guessed URL. The lookup is
 * cached briefly; documentation pages are public, and this is host code, not
 * a run-scoped tool.
 */
import type {
  Processor,
  ProcessOutputResultArgs,
  ProcessOutputStreamArgs,
} from '@mastra/core/processors';
import type { ChunkType } from '@mastra/core/stream';

import { docsBaseUrl } from '../config';
import { docsKnowledge } from '../knowledge';
import { holdbackIndex, normalizePageName, rewriteCitations, type PageResolver, type ResolvedPage } from './citation-text';

/** How long the page name -> URL map is reused before being reloaded. */
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Well-known key the stream runner honours to emit a part after the current one. */
const REPROCESS_PART = '__mastraReprocessPart';

type State = Record<string, unknown> & {
  _citationPending?: string;
  _citationPendingPart?: ChunkType & { type: 'text-delta' };
  _citationPendingNonText?: ChunkType;
};

let pageCache: { at: number; map: Map<string, ResolvedPage> } | null = null;

/** Pull the live docs URL out of the body footer the sync writes on each page. */
function sourceUrlOf(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const matches = [...body.matchAll(/^Source:\s*(https?:\/\/\S+)\s*$/gm)];
  const last = matches.at(-1);
  return last ? last[1].trim() : undefined;
}

/** Load (and cache) every ordinary page in the docs scope, keyed by normalized name. */
async function pageMap(): Promise<Map<string, ResolvedPage>> {
  if (pageCache && Date.now() - pageCache.at < PAGE_CACHE_TTL_MS) return pageCache.map;
  const map = new Map<string, ResolvedPage>();
  try {
    const storage = await docsKnowledge.getStorage();
    let cursor: string | undefined;
    do {
      const out = await storage.listPages({ read: 'all', limit: 100, cursor });
      for (const page of out.pages) {
        if (page.isScope || !page.key) continue;
        const url = sourceUrlOf(page.body) ?? (docsBaseUrl ? `${docsBaseUrl}/${page.key}` : undefined);
        const resolved: ResolvedPage = url ? { name: page.name, url } : { name: page.name };
        map.set(normalizePageName(page.name), resolved);
      }
      cursor = out.nextCursor;
    } while (cursor);
    pageCache = { at: Date.now(), map };
    return map;
  } catch (error) {
    // Degrade to the stale cache (or plain text) rather than fail the run.
    console.warn('[citation-links] listing Knowledge pages failed:', error instanceof Error ? error.message : error);
    return pageCache?.map ?? map;
  }
}

function resolverFor(map: Map<string, ResolvedPage>): PageResolver {
  return name => map.get(normalizePageName(name));
}

/** Append a text-delta to the hold-back buffer. */
function bufferText(state: State, part: ChunkType & { type: 'text-delta' }): void {
  const previous = state._citationPending ?? '';
  if (!previous) state._citationPendingPart = part;
  state._citationPending = previous + part.payload.text;
}

/** Emit everything complete in the buffer as a text-delta, keep the tail back. */
function emitBuffered(state: State, part: ChunkType & { type: 'text-delta' }, resolve: PageResolver) {
  const combined = state._citationPending ?? '';
  const holdFrom = holdbackIndex(combined);
  const emit = rewriteCitations(combined.slice(0, holdFrom), resolve);
  state._citationPending = combined.slice(holdFrom);
  if (!state._citationPending) state._citationPendingPart = undefined;
  if (emit.length === 0) return null;
  return {
    ...part,
    payload: {
      ...part.payload,
      text: emit,
    },
  } satisfies ChunkType;
}

/** Flush whatever is left in the buffer, used when a non-text part arrives. */
function flushBuffered(state: State, resolve: PageResolver) {
  const pending = state._citationPending ?? '';
  state._citationPending = undefined;
  const pendingPart = state._citationPendingPart;
  state._citationPendingPart = undefined;
  if (!pending) return null;
  const text = rewriteCitations(pending, resolve);
  if (!text) return null;
  // Reuse the first buffered part so the flushed text keeps its stream identity.
  const base = pendingPart ?? ({ type: 'text-delta', payload: { id: 'citation-flush', text: '' } } as ChunkType & { type: 'text-delta' });
  return {
    ...base,
    type: 'text-delta' as const,
    payload: {
      ...base.payload,
      text,
    },
  } satisfies ChunkType;
}

export class CitationLinksProcessor implements Processor<'citation-links'> {
  readonly id = 'citation-links';
  readonly name = 'Citation links';
  readonly description = 'Rewrites bracketed page markers and bare Sources lines into markdown links with the page title as text.';

  async processOutputStream(args: ProcessOutputStreamArgs): Promise<ChunkType | null | undefined> {
    const { part, state, writer } = args;
    const s = state as State;
    const resolve = resolverFor(await pageMap());

    // A non-text part was held back so buffered text could flush first.
    const deferred = s._citationPendingNonText;
    if (deferred) {
      s._citationPendingNonText = undefined;
      if (part.type === 'text-delta' && part.payload?.text) {
        // Keep the deferred part first, buffer this delta, emit the deferred part.
        bufferText(s, part as ChunkType & { type: 'text-delta' });
        return deferred;
      }
      // Two non-text parts in a row: the older one goes out, the newer is held.
      s._citationPendingNonText = part;
      return deferred;
    }

    if (part.type === 'text-delta') {
      if (!part.payload?.text) return part;
      bufferText(s, part as ChunkType & { type: 'text-delta' });
      return emitBuffered(s, part as ChunkType & { type: 'text-delta' }, resolve);
    }

    // Any non-text part closes the text run: flush the buffer as a text-delta.
    const flushed = flushBuffered(s, resolve);
    if (flushed) {
      if (writer) s[REPROCESS_PART] = part;
      else s._citationPendingNonText = part;
      return flushed;
    }
    return part;
  }

  async processOutputResult(args: ProcessOutputResultArgs) {
    const { messages } = args;
    const resolve = resolverFor(await pageMap());
    let changed = false;
    const rewritten = messages.map(message => {
      if (message.role !== 'assistant') return message;
      const content = message.content as unknown as {
        parts?: Array<Record<string, unknown> & { type: string; text?: unknown }>;
      };
      if (!Array.isArray(content?.parts)) return message;
      let partChanged = false;
      const parts = content.parts.map(part => {
        if (part.type !== 'text' || typeof part.text !== 'string') return part;
        const text = rewriteCitations(part.text, resolve);
        if (text === part.text) return part;
        partChanged = true;
        return { ...part, text };
      });
      if (!partChanged) return message;
      changed = true;
      return { ...message, content: { ...message.content, parts } } as typeof message;
    });
    return changed ? rewritten : messages;
  }
}

export const citationLinksProcessor = new CitationLinksProcessor();
