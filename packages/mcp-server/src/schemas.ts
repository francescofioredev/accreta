import { z } from "zod/v3";

// Output schemas for the tools that return structuredContent. Every field builds a fresh zod
// instance: zod-to-json-schema turns a reused one into a $ref to another property's path.

const provenance = () =>
  z.object({ page_derived_fields: z.array(z.string()), notice: z.string() });

export const searchPagesOutput = z.object({
  count: z.number().int(),
  results: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      title: z.string(),
      source: z.string().nullable(),
      snippet: z.string(),
      last_verified_revision: z.string().nullable(),
      matched_aliases: z.array(z.string()).optional(),
    }),
  ),
  _provenance: provenance(),
});

// One flat object for found and not found: the SDK only declares an outputSchema that is an object.
export const getPageOutput = z.object({
  found: z.boolean(),
  message: z.string().optional(),
  page: z
    .object({
      path: z.string(),
      type: z.string(),
      title: z.string(),
      source: z.string().nullable(),
      canonical_source: z.string().nullable(),
      last_verified_revision: z.string().nullable(),
      frontmatter: z.record(z.unknown()),
      body: z.string(),
    })
    .optional(),
  _provenance: provenance().optional(),
});

export type SearchPagesOutput = z.infer<typeof searchPagesOutput>;
export type GetPageOutput = z.infer<typeof getPageOutput>;
