import { Knowledge, knowledgeMemoryScopes } from '@mastra/core/knowledge';
// import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { PostgresStore } from '@mastra/pg';

import {
  databaseUrl,
  docsBaseUrl,
  // embedder,
  knowledgeScope,
  pinnedMaxTokens,
  readMaxTokens,
} from '../config';
import type { SanityDocPage, SanityKnowledgeSource } from '../lib/sanity';

/** Provenance recorded on every page this sync writes. */
export const SYNC_AUTHOR = 'sync:sanity';

/**
 * The docs scope: a single `docs:<site>` scope holding the whole documentation
 * tree, readable by every run.
 *
 * Memory's `resource:` and `thread:` scopes are declared too — every run with
 * Memory holds them, and Knowledge rejects undeclared run scopes — but they
 * hold no docs. They only need to be readable by their owner.
 */
const DOCS_SCOPE = {
  description: docsBaseUrl
    ? `The Rallya documentation site at ${docsBaseUrl}. Each page is a docs page from the Sanity CMS.`
    : 'The Rallya documentation site.',
  displayLabel: 'Rallya docs',
  // Anyone holding the scope can read it. Runs are only ever given this exact
  // scope (see `docsAgent.scopes`), so `self` covers every visitor.
  access: [{ principal: 'self' as const, role: 'viewer' as const }],
  // Pinned on every turn: the docs tree (two levels), so the agent always
  // knows what exists and can go straight to `knowledge_read`.
  pinnedContext: [{ list: knowledgeScope, depth: 2 }],
};

/**
 * Postgres-backed Knowledge for the Rallya docs.
 *
 * - `PostgresStore` keeps pages, notes and links.
 * - Semantic matching is disabled: `PgVector` + the embedder are commented out
 *   below, so `knowledge_search` is keyword-only.
 * - `tools: { read: true }` gives agents only `knowledge_list`,
 *   `knowledge_search` and `knowledge_read`. There are deliberately no write
 *   tools: the agent cannot change the docs; content only changes through
 *   `scripts/sync-sanity.ts`.
 * - `pinnedContext` delivers the docs tree on every turn (needs Memory).
 */
export const docsKnowledge = new Knowledge({
  id: 'rallya-docs',
  description: 'The Rallya documentation: product guides, API and SDK references.',
  storage: new PostgresStore({
    id: 'rallya-docs-storage',
    connectionString: databaseUrl,
  }),
  // vector: new PgVector({
  //   id: 'rallya-docs-vector',
  //   connectionString: databaseUrl,
  // }),
  // embedder: new ModelRouterEmbeddingModel(embedder),
  scopes: {
    // resource:<userId> and thread:<threadId>, owned by the run that holds them.
    // `org: false`: there is no tenant here.
    ...knowledgeMemoryScopes({ org: false }),
    'docs:$siteId': DOCS_SCOPE,
    // The concrete address is declared too so it exists before the first sync.
    [knowledgeScope]: DOCS_SCOPE,
  },
  tools: { read: { maxTokens: readMaxTokens } },
  pinnedContext: { maxTokens: pinnedMaxTokens },
});

/** Turn a Sanity slug (`getting-started`, `api/keys`) into a Knowledge page path. */
export function toKnowledgePath(slug: string): string {
  return slug
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .join('/');
}

/** Page key for a doc: its slug with nested segments joined, e.g. `api/keys` → `api-keys`. */
export function toKnowledgeKey(slug: string): string {
  return toKnowledgePath(slug).replace(/\//g, '-');
}

/** Page key of the generated docs-structure overview. */
export const SECTIONS_PAGE = 'docs-structure';

/**
 * Page summary. Search ranks a hit in the page name above one in the
 * description and the description above the body, so the description repeats
 * the words people are likely to search for (title, section, slug).
 */
function toDescription(page: SanityDocPage): string {
  const summary = page.description?.trim() || `${page.title} — Rallya documentation.`;
  const trimmed = summary.length > 240 ? `${summary.slice(0, 237).trimEnd()}…` : summary;
  const context = [page.section?.title && `${page.section.title} section`, page.slug]
    .filter(Boolean)
    .join(', ');
  return context ? `${trimmed} (${page.title}; ${context})` : trimmed;
}

/**
 * Public docs URL for a Sanity page. Folders in the slug keep their `/`
 * (`api/keys` → `/docs/api/keys`), and the docs index (`index`) maps to the
 * site root.
 */
export function toDocsUrl(baseUrl: string, slug: string): string {
  const path = slug.replace(/^\/+|\/+$/g, '');
  return path && path !== 'index' ? `${baseUrl}/${path}` : baseUrl;
}

/**
 * Markdown body for one Sanity page: the title, its description and the MDX
 * body from the Studio, plus a link back to the live page when `baseUrl` is set.
 */
export function toKnowledgeBody(page: SanityDocPage, baseUrl?: string): string {
  const parts = [`# ${page.title}`];

  if (page.description) parts.push(page.description);
  if (page.body?.trim()) parts.push(page.body.trim());
  if (baseUrl && page.slug) parts.push(`Source: ${toDocsUrl(baseUrl, page.slug)}`);

  return parts.join('\n\n');
}

/**
 * Synchronise the Sanity docs into Knowledge.
 *
 * - Each `docPage` becomes `<scope>#<key>`, where the key is its slug with `/`
 *   replaced by `-` (`api/keys` → `docs:rallya#api-keys`). Knowledge treats
 *   `/` in a path as a page hierarchy, so flattening keeps one page per doc.
 * - The sections are written as one `<scope>#docs-structure` page.
 *
 * Safe to re-run: `upsertPage()` skips unchanged pages (no rewrite, no
 * re-embedding).
 *
 * Host-only: `upsertPage()` bypasses run scopes and access rules, so this must
 * never be called from an agent tool or from a route without admin auth.
 */
export async function syncSanityDocs(source: SanityKnowledgeSource, baseUrl?: string) {
  const results: Record<'created' | 'updated' | 'unchanged', number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
  };

  // Sections are part of the overview page (they'd become extra tree nodes at
  // the same level as the pages), so the agent can always answer "what's in the
  // Reference section?" from the pinned tree plus `docs:rallya#index`.
  if (source.sections.length > 0) {
    const overview = [
      '# Docs structure',
      'The Rallya docs are grouped into these sections:',
      ...source.sections.map(section => {
        const pages = source.pages.filter(page => page.section?.title === section.title);
        return `## ${section.title}\n${pages.map(page => `- ${page.title}`).join('\n')}`;
      }),
    ].join('\n\n');

    const { status } = await docsKnowledge.upsertPage({
      scope: knowledgeScope,
      path: SECTIONS_PAGE,
      name: 'Docs structure',
      description: 'Every section of the Rallya docs and the pages each one contains.',
      body: overview,
      author: SYNC_AUTHOR,
    });
    results[status] += 1;
  }

  for (const page of source.pages) {
    const path = toKnowledgeKey(page.slug);
    if (!path) continue;

    const description = toDescription(page);

    const { status } = await docsKnowledge.upsertPage({
      scope: knowledgeScope,
      path,
      name: page.title,
      description,
      body: toKnowledgeBody(page, baseUrl),
      author: SYNC_AUTHOR,
    });
    results[status] += 1;

    if (page.section?.overview) {
      // A note points at the page (per-section overview text from the CMS).
      // Notes can't be updated in place, so add one only when the page was
      // written; re-running the sync on unchanged docs never duplicates it.
      await docsKnowledge.addNote({
        scope: knowledgeScope,
        path,
        text: page.section.overview.slice(0, 900),
        author: SYNC_AUTHOR,
      });
    }
  }

  return results;
}
