/**
 * Deterministic rewrite of the citation markers the model slips into answers.
 *
 * The model is told (see ../instructions/doc.instructions.ts) to cite pages as
 * markdown links with the page title as link text, but it sometimes emits its
 * own marker: the page name and a heading slug wrapped in fullwidth brackets,
 * e.g. 【Auth#user-sessions】. This module turns those into the citation the
 * instructions ask for, and linkifies bare page names left on a "Sources:"
 * line. It never invents URLs: a marker whose page is unknown degrades to the
 * page name as plain text.
 */

/** The minimum a page needs to be linked: its display name and its docs URL. */
export type ResolvedPage = { name: string; url?: string };

/** Resolve a page name as written by the model to a page, or undefined. */
export type PageResolver = (name: string) => ResolvedPage | undefined;

/** Lowercase, unaccented, letters and digits only; used to match page names. */
export function normalizePageName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Turn a heading slug fragment ("typescript-—-`@rallya/sdk`") into a docs anchor. */
export function sanitizeAnchor(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build the markdown citation for a resolved page. */
function linkFor(page: ResolvedPage, anchor: string): string {
  if (!page.url) return page.name;
  return anchor ? `[${page.name}](${page.url}#${anchor})` : `[${page.name}](${page.url})`;
}

/** Rewrite every fullwidth-bracketed marker in the text. */
function rewriteBracketedMarkers(text: string, resolve: PageResolver): string {
  return text.replace(/【([^【】]{0,512})】/gu, (_match, inner: string) => {
    const trimmed = inner.trim();
    const hash = trimmed.indexOf('#');
    const name = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
    const anchor = hash === -1 ? '' : sanitizeAnchor(trimmed.slice(hash + 1));
    if (!name) return '';
    const page = resolve(name);
    // Unknown page: drop the marker, keep the words, never link blindly.
    if (!page?.url) return name;
    return linkFor(page, anchor);
  });
}

/** Linkify bare entries on "Sources:" lines that name a known page. */
function rewriteSourcesLine(text: string, resolve: PageResolver): string {
  return text.replace(/Sources:[ \t]*([^\n]*)/gu, (_match, list: string) => {
    const items = list.split(',').map(item => item.trim());
    const rewritten = items.map(item => {
      // Existing markdown links and empty entries stay as they are.
      if (!item || item.startsWith('[')) return item;
      const page = resolve(item);
      return page?.url ? `[${page.name}](${page.url})` : item;
    });
    return `Sources: ${rewritten.join(', ')}`;
  });
}

/**
 * Rewrite every marker and stray fullwidth bracket in `text`.
 * Pure and synchronous; the async page lookup happens in the resolver the
 * caller hands in.
 */
export function rewriteCitations(text: string, resolve: PageResolver): string {
  const bracketed = rewriteBracketedMarkers(text, resolve);
  const sourcesLine = rewriteSourcesLine(bracketed, resolve);
  // Anything still between brackets was half a marker the regex could not
  // close; the brackets must not reach the developer.
  return sourcesLine.replace(/[【】]/gu, '');
}

/**
 * Hold-back index for streaming: where to stop emitting so an incomplete
 * marker (or an open "Sources:" line) stays buffered until the rest of it
 * arrives. Returns `text.length` when nothing needs holding.
 */
export function holdbackIndex(text: string, maxHold = 512): number {
  let holdFrom = text.length;

  const lastOpen = text.lastIndexOf('【');
  if (lastOpen !== -1 && text.indexOf('】', lastOpen) === -1) {
    holdFrom = Math.min(holdFrom, lastOpen);
  }

  // Hold the trailing line when it is (a prefix of) the "Sources:" line: the
  // bare-name lookups need the whole line, and a split literal never matches.
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart);
  if (line.length > 0 && 'Sources:'.startsWith(line)) {
    holdFrom = Math.min(holdFrom, lineStart);
  } else if (line.startsWith('Sources:')) {
    holdFrom = Math.min(holdFrom, lineStart);
  }

  // A hold longer than this is a marker runaway; emit rather than withhold
  // the whole answer (the stored copy is rewritten again on completion).
  return text.length - holdFrom > maxHold ? text.length : holdFrom;
}
