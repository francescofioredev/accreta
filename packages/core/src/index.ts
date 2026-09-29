export type { AccretaConfig, ConfigCheck } from "./config.ts";
export { DEFAULT_CONFIG, checkConfig, configFromObject, parseConfig } from "./config.ts";

export type { CitationParts, CitationTemplate, Footnote, TemplateResult } from "./citations.ts";
export { compileCitationTemplate, extractFootnotes } from "./citations.ts";

export type { Frontmatter, ParsedPage } from "./page.ts";
export { parsePage } from "./page.ts";

export type { ExtractedLink, LinkKind } from "./links.ts";
export type { ResolvedWikilink } from "./links.ts";
export { INLINE_LINK_KIND, extractLinks, resolveWikilink, tryResolveWikilink } from "./links.ts";

export type { BuildOptions, BuildResult } from "./index-db/build.ts";
export { buildIndex } from "./index-db/build.ts";
export type { Database, OpenOptions } from "./index-db/db.ts";
export { openIndex, sealForReading } from "./index-db/db.ts";

export type {
  LocationVerdict,
  LocatorChange,
  ParsedCitation,
  SourceAdapter,
} from "./source/adapter.ts";
export {
  UNPINNED_REVISION,
  DelegatedSourceError,
  UnknownRevisionError,
  formatCanonicalSource,
  formatCitation,
  parseCitation,
  parseLineLocator,
  resolveInside,
} from "./source/adapter.ts";
export type { Citation } from "./source/cite.ts";
export { cite } from "./source/cite.ts";
export type {
  CitedChange,
  DelegatedWork,
  PageChange,
  DriftReport,
  StaleRevision,
  UnresolvableRevision,
} from "./source/drift.ts";
export { detectDrift, pageChanges } from "./source/drift.ts";
export type { SourceDeclaration, SourceFactory } from "./source/registry.ts";
export { SourceRegistry, countPagesOfSource, parseSourceDeclaration } from "./source/registry.ts";

export type { SearchHit, SearchOptions } from "./query/search.ts";
export { searchPages } from "./query/search.ts";
export type { CanonicalMatch, PageRecord, Relation } from "./query/page.ts";
export { findCanonical, findRelated, getPage } from "./query/page.ts";
export type { LintFinding, LintReport } from "./query/lint.ts";
export { lint, lintCitations } from "./query/lint.ts";
