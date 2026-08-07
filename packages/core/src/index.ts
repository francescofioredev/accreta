export type { AccretaConfig } from "./config.ts";
export { DEFAULT_CONFIG, configFromObject, parseConfig } from "./config.ts";

export type { Frontmatter, ParsedPage } from "./page.ts";
export { parsePage } from "./page.ts";

export type { ExtractedLink, LinkKind } from "./links.ts";
export type { ResolvedWikilink } from "./links.ts";
export { INLINE_LINK_KIND, extractLinks, resolveWikilink, tryResolveWikilink } from "./links.ts";

export type { BuildOptions, BuildResult } from "./index-db/build.ts";
export { buildIndex } from "./index-db/build.ts";
export type { Database, OpenOptions } from "./index-db/db.ts";
export { openIndex, sealForReading } from "./index-db/db.ts";
