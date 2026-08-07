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
 * The outcome of resolving a wikilink.
 *
 * A target that climbs out of the knowledge base is a distinct outcome rather
 * than an error or a silent drop: the indexer wants to record it as a broken
 * link so `lint` can report it, and reporting is the entire point — see below.
 */
export type ResolvedWikilink =
  { ok: true; path: string } | { ok: false; reason: "escapes-knowledge-base"; target: string };

/**
 * Collapse `.` and `..` segments in a knowledge-base-relative path.
 *
 * Deliberately string-only: `node:path` would resolve against the process
 * working directory and drag platform separators into what is a
 * knowledge-base-relative identifier, not a filesystem location. A leading `..`
 * that cannot be collapsed is kept so the caller can detect the escape.
 */
function normalizeSegments(input: string): { segments: string[]; climbs: number } {
  const out: string[] = [];
  let climbs = 0;

  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      else climbs++;
      continue;
    }
    out.push(segment);
  }

  return { segments: out, climbs };
}

/**
 * Turn a wikilink target into the knowledge-base-relative path of the page it
 * refers to.
 *
 * Normalization is not cosmetic. A link written `[[../modules/foo]]` renders and
 * navigates correctly on GitHub — the author has no reason to suspect anything
 * — while the unnormalized path `knowledge/../modules/foo.md` matches no indexed
 * page, so the edge is simply missing from the graph. Impact analysis then
 * under-reports with no symptom at all, and a shorter list of consumers looks
 * exactly like a correct one. In the corpus this was found in, nine links had
 * this shape and none of them resolved.
 */
export function resolveWikilink(target: string, config: AccretaConfig): string {
  const resolved = tryResolveWikilink(target, config);
  return resolved.ok ? resolved.path : `${normalizeTargetForDisplay(target)}.md`;
}

function normalizeTargetForDisplay(target: string): string {
  const trimmed = target.trim();
  return trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
}

/**
 * Resolve a wikilink, distinguishing a target that escapes the knowledge base
 * from one that resolves cleanly.
 */
export function tryResolveWikilink(target: string, config: AccretaConfig): ResolvedWikilink {
  let t = target.trim();
  if (t.endsWith(".md")) t = t.slice(0, -3);
  if (t.startsWith("/")) t = t.slice(1);

  const base = config.knowledgeBase;
  const baseSegments = normalizeSegments(base).segments;

  // A leading `../` is the author writing relative to their own page's
  // directory — which is exactly why the link works on GitHub — not an attempt
  // to leave the knowledge base. `[[../modules/foo]]` written from
  // `knowledge/concepts/x.md` means `knowledge/modules/foo.md`, the same page
  // `[[modules/foo]]` names. Since the resolved path must not depend on which
  // page happens to link, those leading hops are dropped and the remainder is
  // taken as knowledge-base-relative.
  const { segments: targetSegments, climbs } = normalizeSegments(t);

  if (targetSegments.length === 0) {
    return { ok: false, reason: "escapes-knowledge-base", target: target.trim() };
  }

  // Strip a knowledge-base prefix the author spelled out, so `knowledge/x` and
  // `x` name one page rather than two.
  let rest = targetSegments;
  if (
    baseSegments.length > 0 &&
    rest.length > baseSegments.length &&
    rest.slice(0, baseSegments.length).join("/") === baseSegments.join("/")
  ) {
    rest = rest.slice(baseSegments.length);
  }

  const segments = [...baseSegments, ...rest];

  // A page inside the knowledge base can climb at most as many levels as the
  // base is deep before it is outside it. `[[../../etc/passwd]]` from a base one
  // directory deep climbs further than any page in it could, so it is reported
  // rather than turned into an unmatchable path — silence is precisely what made
  // the original defect expensive to find.
  //
  // A base of `.` is zero levels deep, so any leading climb leaves it.
  if (climbs > Math.max(baseSegments.length, 1)) {
    return { ok: false, reason: "escapes-knowledge-base", target: target.trim() };
  }

  return { ok: true, path: `${segments.join("/")}.md` };
}
