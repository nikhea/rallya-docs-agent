/**
 * Sync the Rallya docs from Sanity into Mastra Knowledge.
 *
 *   bun run sync                 # pages in Sanity -> Knowledge
 *   bun run sync -- --dry-run    # report what would change
 *   bun run sync -- --remove     # also delete Knowledge pages whose doc page
 *                                # was deleted from Sanity
 *   bun run sync -- --remove --force   # ... including pages that still have
 *                                      # child pages
 *
 * Safe to re-run: `upsertPage()` skips pages whose body is unchanged, so
 * unchanged pages are neither rewritten nor re-embedded.
 *
 * Host-only script: it writes with `upsertPage()`, which bypasses run scopes.
 * Keep it out of the HTTP server.
 */
import { docsBaseUrl, knowledgeScope } from '../src/mastra/config';
import {
  docsKnowledge,
  SYNC_AUTHOR,
  syncSanityDocs,
  toKnowledgeKey,
  SECTIONS_PAGE,
} from '../src/mastra/knowledge';
import { fetchSanityDocs } from '../src/mastra/lib/sanity';

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const remove = flags.has('--remove');
// Removes children before their parent, so a page that still has children
// (e.g. the old `sections` tree) doesn't block the prune.
const force = flags.has('--force');

async function main() {
  console.log(`Reading docs from Sanity → Knowledge scope "${knowledgeScope}"`);
  if (dryRun) console.log('Dry run: nothing will be written.');

  const source = await fetchSanityDocs();
  console.log(`Sanity returned ${source.pages.length} page(s) and ${source.sections.length} section(s).`);

  if (source.pages.length === 0) {
    console.warn('No published docPage documents found — check the Studio has content and the token can read it.');
  }

  if (dryRun) {
    for (const page of source.pages) {
      const path = toKnowledgeKey(page.slug);
      if (path) console.log(`  would upsert ${knowledgeScope}#${path}  (${page.title})`);
    }
    if (source.sections.length > 0) console.log(`  would upsert ${knowledgeScope}#${SECTIONS_PAGE}`);
    return;
  }

  const result = await syncSanityDocs(source, docsBaseUrl);
  console.log(
    `Synced: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged.`,
  );

  if (remove) {
    // Pages deleted in Sanity would otherwise stay searchable forever. The
    // tree walk reads everything under the docs scope (host script, so
    // `read: 'all'`), and only pages sync owns are pruned.
    const { listKnowledgeTreeChildren } = await import('@mastra/core/knowledge');
    const storage = await docsKnowledge.getStorage();
    console.log('Pruning pages that no longer exist in Sanity…');

    const wanted = new Set<string>([
      ...source.pages.map(page => toKnowledgeKey(page.slug)).filter(Boolean),
      ...(source.sections.length > 0 ? [SECTIONS_PAGE] : []),
    ]);

    const [docsScope] = await storage.getScopesByAddress([knowledgeScope]);
    if (!docsScope) {
      console.log('  docs scope does not exist yet; nothing to prune.');
    } else {
      // Walk the scope depth-first (pages can nest) and delete stale leaves
      // bottom-up. `countChildPages` counts only live children, so a parent
      // becomes removable once its children are gone.
      const liveChildren = async (pageId: string) =>
        (await listKnowledgeTreeChildren(storage, { parentId: pageId, read: 'all', limit: 500 })).pages.filter(
          page => !page.isScope,
        );

      const prune = async (parentId: string): Promise<boolean> => {
        let changed = false;

        for (const page of await liveChildren(parentId)) {
          const children = await liveChildren(page.id);
          if (children.length > 0) {
            changed = (await prune(page.id)) || changed;
          }

          if (!page.key || wanted.has(page.key) || page.createdBy.author !== SYNC_AUTHOR) continue;

          // A page can still hold pages this sync doesn't own (e.g. written
          // by hand); only --force removes it once its own pages are gone.
          const remaining = await liveChildren(page.id);
          if (remaining.length > 0) {
            if (!force) {
              console.log(`  kept ${knowledgeScope}#${page.key} (still has child pages; re-run with --force)`);
              continue;
            }
            // --force: children we own were already removed above, so this
            // leaves only pages this sync must not delete.
            console.log(`  kept ${knowledgeScope}#${page.key} (has pages it did not write)`);
            continue;
          }

          const removed = await docsKnowledge.removePage({
            scope: knowledgeScope,
            path: page.key,
            author: SYNC_AUTHOR,
          });
          if (removed) {
            console.log(`  removed ${knowledgeScope}#${page.key}`);
            changed = true;
          }
        }

        return changed;
      };

      await prune(docsScope.id);
    }
  }

  console.log('Done. Open Studio (bun run dev) → Knowledge to browse the result.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
