import { createClient } from '@sanity/client';

/**
 * Sanity project holding the Rallya docs (`rallya-docs/sanity/schema.ts`).
 *
 * The project id and dataset are not secrets — the embedded Studio ships them
 * to the browser — so they default to the rallya-docs values. The dataset is
 * private, so reading it from the agent needs a read token.
 */
const DEFAULT_PROJECT_ID = 'ejoyp5f4';
const DEFAULT_DATASET = 'production';

/** A docs page as stored in Sanity (`docPage` type). */
export type SanityDocPage = {
  id: string;
  title: string;
  slug: string;
  description?: string;
  order: number;
  body?: string;
  section?: { title: string; order: number; overview?: string } | null;
};

/** A sidebar section (`docSection` type). */
export type SanityDocSection = {
  id: string;
  title: string;
  order: number;
};

export type SanityKnowledgeSource = {
  pages: SanityDocPage[];
  sections: SanityDocSection[];
};

const pagesQuery = `*[_type == "docPage"] | order(section->order asc, order asc) {
  "id": _id,
  title,
  "slug": slug.current,
  description,
  order,
  body,
  "section": section->{ title, order, overview }
}`;

const sectionsQuery = `*[_type == "docSection"] | order(order asc) {
  "id": _id,
  title,
  order
}`;

export function createSanityClient() {
  const projectId = process.env.SANITY_PROJECT_ID || DEFAULT_PROJECT_ID;
  const dataset = process.env.SANITY_DATASET || DEFAULT_DATASET;
  const token = process.env.SANITY_API_READ_TOKEN || process.env.SANITY_READ_TOKEN;

  if (!token) {
    throw new Error(
      'Missing a Sanity read token. Set SANITY_API_READ_TOKEN in .env (the dataset is private).',
    );
  }

  return createClient({ projectId, dataset, apiVersion: '2025-11-01', token, useCdn: false });
}

/** Reads every published docs page and section from Sanity. */
export async function fetchSanityDocs(): Promise<SanityKnowledgeSource> {
  const client = createSanityClient();
  const [pages, sections] = await Promise.all([
    client.fetch<SanityDocPage[]>(pagesQuery),
    client.fetch<SanityDocSection[]>(sectionsQuery),
  ]);
  return { pages: pages ?? [], sections: sections ?? [] };
}
