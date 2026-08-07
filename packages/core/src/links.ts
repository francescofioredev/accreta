import type { AccretaConfig } from "./config.ts";
import type { Frontmatter } from "./page.ts";
import { WIKILINK_RE } from "./page.ts";

/**
 * A link's kind is either the frontmatter field it came from — and those are
 * configuration, so the set is not known at compile time — or `wikilink` for an
 * untyped mention in the body.
 */
export type LinkKind = string;

export const INLINE_LINK_KIND = "wikilink";

export interface ExtractedLink {
  target: string;
  kind: LinkKind;
}

/**
 * Collect wikilink targets from a frontmatter value.
 *
 * The value may be a bare string, a list, or a list of lists once the YAML
 * preprocessing has quoted things, so this walks whatever shape it is handed
 * rather than assuming one.
 */
function collectTargets(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(WIKILINK_RE)) {
      const target = match[1]?.trim();
      if (target) into.push(target);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, into);
  }
}

/**
 * Extract every link on a page: typed relations from the configured
 * `link_fields`, and untyped mentions from inline `[[...]]` in the body.
 *
 * Which frontmatter fields carry links is configuration. The reference
 * implementation kept the list as a module-level constant, which is how a
 * knowledge base about anything other than source code ends up unable to
 * describe its own relations.
 */
export function extractLinks(
  frontmatter: Frontmatter,
  body: string,
  config: AccretaConfig,
): ExtractedLink[] {
  const out: ExtractedLink[] = [];

  for (const field of config.linkFields) {
    const value = frontmatter[field];
    if (!value) continue;
    const targets: string[] = [];
    collectTargets(value, targets);
    for (const target of targets) out.push({ target, kind: field });
  }

  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) out.push({ target, kind: INLINE_LINK_KIND });
  }

  return out;
}

/**
 * Turn a wikilink target into the knowledge-base-relative path of the page it
 * refers to.
 */
export function resolveWikilink(target: string, config: AccretaConfig): string {
  let t = target.trim();
  if (t.endsWith(".md")) t = t.slice(0, -3);
  const base = config.knowledgeBase;
  if (!t.startsWith(`${base}/`) && !t.startsWith("/")) {
    t = `${base}/${t}`;
  }
  if (t.startsWith("/")) t = t.slice(1);
  return `${t}.md`;
}
