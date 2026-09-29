-- The index is derived and disposable: it is rebuilt from the knowledge base in
-- one pass, so it is never committed and never migrated. Changing this file
-- means the next rebuild produces the new shape, and that is the whole
-- migration story.

CREATE TABLE IF NOT EXISTS pages (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,

  -- The columns below are the vocabulary-independent ones. Everything a
  -- particular knowledge base cares about lives in frontmatter_json: promoting
  -- `symbol`, `route` or `method` to columns, as the reference implementation
  -- did, bakes one domain's vocabulary into the schema and leaves every other
  -- domain with columns that are always NULL.
  source TEXT,
  canonical_source TEXT,
  last_verified_revision TEXT,
  last_ingest_revision TEXT,
  last_ingest_at TEXT,

  frontmatter_json TEXT NOT NULL,
  body TEXT NOT NULL,
  mtime INTEGER NOT NULL,

  -- Set when the frontmatter fence was present but would not load. A page is
  -- indexed anyway, so this is what separates "declares nothing" from "declares
  -- things that were all discarded" — without it `lint` can only report the
  -- symptoms of the second and never its cause.
  frontmatter_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source);
-- findCanonical compares titles through LOWER(); a plain index on title would not serve it.
CREATE INDEX IF NOT EXISTS idx_pages_title_lower ON pages(LOWER(title));

-- `aliases` is indexed alongside title and body because the name a question
-- arrives under is rarely the name the page was filed under. Leaving it out
-- measurably hurt retrieval: alias queries scored 40% recall@1 with it absent
-- and 100% with it present (bench/, 20 queries). The editorial work of
-- declaring an alias is exactly the signal a curated corpus has and a scraped
-- one does not, and discarding it at index time then blaming lexical search is
-- how a system argues itself into needing embeddings it does not need.
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  aliases,
  body,
  path UNINDEXED,
  type UNINDEXED,
  source UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Each entry of a list-valued `aliases`, trimmed and lower-cased as findCanonical compares it.
-- Its own table because a LIKE over frontmatter_json can use no index and scans every page.
CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (alias, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS links (
  src_path TEXT NOT NULL,
  dst_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src_path, dst_path, kind)
);

CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_path, kind);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_path, kind);

-- A wikilink that cannot be resolved to a page inside the knowledge base. Kept
-- rather than dropped: an unresolvable link is exactly what `lint` needs to
-- report, and silently discarding it is how the '..' defect stayed invisible.
CREATE TABLE IF NOT EXISTS broken_links (
  src_path TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (src_path, target, kind)
);

-- One row per footnote that reads as a citation attempt. `source` is NULL when the
-- definition does not parse as provenance.format, which lint reports rather than drops.
CREATE TABLE IF NOT EXISTS citations (
  page_path TEXT NOT NULL,
  footnote TEXT NOT NULL,
  line INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  revision TEXT,
  path TEXT,
  locator TEXT,
  claim TEXT NOT NULL,
  -- Keyed by line: a footnote id defined twice is a finding, and the second copy must survive to be one.
  PRIMARY KEY (page_path, line)
);

CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source, path);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
