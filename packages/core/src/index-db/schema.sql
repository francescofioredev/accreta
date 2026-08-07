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
  mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_source ON pages(source);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  body,
  path UNINDEXED,
  type UNINDEXED,
  source UNINDEXED,
  tokenize = 'porter unicode61'
);

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

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
