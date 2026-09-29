import type { Database } from "../index-db/db.ts";
import { DEFAULT_SUPERSESSION_FIELDS, type AccretaConfig } from "../config.ts";
import type { LintFinding } from "./lint.ts";

const KIND = "inconsistent-supersession";
const CONFIG_PATH = "accreta.config.yaml";

// ADR-0007 pages cap the number of findings, not their size, so one loop must not name 20k pages.
const MAX_NAMED = 20;

const LOOP_ADVICE =
  "Between pages that each stand for one document, supersession cannot loop. A loop usually means one page stands for two revisions (for example a reinstated version), so split that page. If this knowledge base uses these fields for something that can loop, set supersession_fields: false";

const order = (finding: LintFinding) => `${finding.path}\0${finding.detail}`;

interface EdgeRow {
  src_path: string;
  dst_path: string;
  kind: string;
}

/** One "successor replaced predecessor" claim, and which side of it declares it. */
interface Claim {
  successor: string;
  predecessor: string;
  bySuccessor: boolean;
  byPredecessor: boolean;
}

/**
 * Supersession claims that cannot all hold: a loop, or a claim only one of its two pages records.
 * Both fields read as one relation; edges to missing pages are left to `dangling-link`.
 */
export function supersessionFindings(db: Database, config: AccretaConfig): LintFinding[] {
  const setting = config.supersessionFields;
  if (setting === null) return [];
  if (setting && "invalid" in setting) {
    return [
      {
        kind: "unreadable-supersession-fields",
        path: CONFIG_PATH,
        detail:
          "supersession_fields is set but is not two distinct link-field names, so supersession was not checked",
      },
    ];
  }
  const { supersedes, supersededBy } = setting ?? DEFAULT_SUPERSESSION_FIELDS;

  const missing = [supersedes, supersededBy].filter((field) => !config.linkFields.includes(field));
  // Unset, a knowledge base without the default pair simply does not use supersession.
  if (missing.length > 0 && !setting) return [];
  if (missing.length > 0) {
    return [
      {
        kind: "unreadable-supersession-fields",
        path: CONFIG_PATH,
        detail: `supersession_fields names ${missing.join(" and ")}, which link_fields does not list, so supersession was not checked; add it to link_fields, or set supersession_fields to false`,
      },
    ];
  }

  const rows = db
    .query(
      `SELECT l.src_path, l.dst_path, l.kind FROM links l
       JOIN pages p ON p.path = l.dst_path
       WHERE l.kind IN (?, ?)`,
    )
    .all(supersedes, supersededBy) as EdgeRow[];
  // Such a page's links were never read, so saying it lacks one would be false.
  const unreadable = new Set(
    (
      db.query(`SELECT path FROM pages WHERE frontmatter_error IS NOT NULL`).all() as {
        path: string;
      }[]
    ).map((row) => row.path),
  );

  const claims = new Map<string, Claim>();
  for (const row of rows) {
    const bySuccessor = row.kind === supersedes;
    const successor = bySuccessor ? row.src_path : row.dst_path;
    const predecessor = bySuccessor ? row.dst_path : row.src_path;
    const key = `${successor}\0${predecessor}`;
    const claim = claims.get(key) ?? {
      successor,
      predecessor,
      bySuccessor: false,
      byPredecessor: false,
    };
    if (bySuccessor) claim.bySuccessor = true;
    else claim.byPredecessor = true;
    claims.set(key, claim);
  }

  const next = new Map<string, string[]>();
  for (const { successor, predecessor } of claims.values()) {
    const out = next.get(successor) ?? [];
    out.push(predecessor);
    next.set(successor, out);
  }
  for (const out of next.values()) out.sort();

  const findings: LintFinding[] = [];
  const inLoop = new Map<string, number>();
  loopsIn(next).forEach((members, id) => {
    for (const page of members) inLoop.set(page, id);
    findings.push({ kind: KIND, path: members[0]!, detail: describeLoop(members, next) });
  });

  for (const claim of claims.values()) {
    const { successor, predecessor } = claim;
    // Inside a loop the claim itself is in doubt, so asking for its reciprocal would be bad advice.
    const loop = inLoop.get(successor);
    if (loop !== undefined && loop === inLoop.get(predecessor)) continue;
    if (claim.bySuccessor && claim.byPredecessor) continue;
    if (claim.bySuccessor) {
      if (unreadable.has(predecessor)) continue;
      findings.push({
        kind: KIND,
        path: successor,
        detail: `${successor} says ${supersedes}: ${predecessor}, but ${predecessor} does not record it. Find the line in ${successor}'s source that says so; if it exists, record ${supersededBy} on ${predecessor} citing that line. If no source says it, remove the claim`,
      });
    } else {
      if (unreadable.has(successor)) continue;
      // A document never names what later replaced it, so the old page's own source cannot be the evidence.
      findings.push({
        kind: KIND,
        path: predecessor,
        detail: `${predecessor} says ${supersededBy}: ${successor}, but ${successor} does not record it. The evidence must come from ${successor}'s source or a registry, never from ${predecessor}'s own source; if such a line exists, record ${supersedes} on ${successor} citing it. If no source says it, remove the claim`,
      });
    }
  }

  return findings.toSorted((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

function describeLoop(members: string[], next: Map<string, string[]>): string {
  const first = members[0]!;
  const selves = members.filter((page) => next.get(page)?.includes(page));
  const parts: string[] = [];
  let budget = MAX_NAMED;

  if (members.length > 1) {
    const cycle = shortestLoop(first, new Set(members), next);
    const shown = cycle.slice(0, budget);
    budget -= shown.length;
    const path =
      shown.length < cycle.length
        ? `${shown.join(" → ")} → … ${cycle.length - shown.length} more … → ${first}`
        : [...cycle, first].join(" → ");
    parts.push(
      `${members.length} pages claim to supersede one another in a loop: ${path} (each supersedes the next)`,
    );
    const onCycle = new Set(cycle);
    const rest = members.filter((page) => !onCycle.has(page));
    if (rest.length > 0) {
      parts.push(`the loop also takes in ${named(rest, budget)}`);
      budget -= Math.min(rest.length, budget);
    }
  }
  if (selves.length > 0) {
    const one = selves.length === 1;
    parts.push(
      `${named(selves, budget)} ${one ? "claims" : "claim"} to supersede ${one ? "itself" : "themselves"}`,
    );
  }
  return `${parts.join(", and ")}. ${LOOP_ADVICE}`;
}

function named(pages: string[], budget: number): string {
  const shown = pages.slice(0, Math.max(budget, 0));
  if (shown.length === pages.length) return shown.join(", ");
  if (shown.length === 0) return `${pages.length} more pages`;
  return `${shown.join(", ")} and ${pages.length - shown.length} more`;
}

/** The pages of the shortest loop from `start` back to itself, walking only `members`. */
function shortestLoop(start: string, members: Set<string>, next: Map<string, string[]>): string[] {
  const parent = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const page = queue[head]!;
    for (const target of next.get(page) ?? []) {
      if (target === start) {
        if (page === start) continue;
        const path = [page];
        while (path[path.length - 1] !== start) path.push(parent.get(path[path.length - 1]!)!);
        return path.toReversed();
      }
      if (members.has(target) && !parent.has(target)) {
        parent.set(target, page);
        queue.push(target);
      }
    }
  }
  return [start];
}

// Tarjan over integer ids with explicit stacks: a long chain cannot overflow, and each page and edge is visited once (#80).
function loopsIn(next: Map<string, string[]>): string[][] {
  const names = [...new Set([...next.keys(), ...[...next.values()].flat()])].toSorted();
  const id = new Map(names.map((name, i) => [name, i]));
  const edges = names.map((name) => (next.get(name) ?? []).map((target) => id.get(target)!));
  const n = names.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const loops: string[][] = [];
  let counter = 0;

  const visit = (page: number) => {
    index[page] = low[page] = counter++;
    stack.push(page);
    onStack[page] = 1;
  };

  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    visit(start);
    const work = [start];
    const cursor = [0];
    while (work.length > 0) {
      const top = work.length - 1;
      const page = work[top]!;
      const targets = edges[page]!;
      if (cursor[top]! < targets.length) {
        const target = targets[cursor[top]!++]!;
        if (index[target] === -1) {
          visit(target);
          work.push(target);
          cursor.push(0);
        } else if (onStack[target]) {
          low[page] = Math.min(low[page]!, index[target]!);
        }
        continue;
      }
      work.pop();
      cursor.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!;
        low[parent] = Math.min(low[parent]!, low[page]!);
      }
      if (low[page] !== index[page]) continue;
      const component: number[] = [];
      let member: number;
      do {
        member = stack.pop()!;
        onStack[member] = 0;
        component.push(member);
      } while (member !== page);
      if (component.length > 1 || targets.includes(page)) {
        loops.push(component.toSorted((a, b) => a - b).map((i) => names[i]!));
      }
    }
  }
  return loops.toSorted((a, b) => (a[0]! < b[0]! ? -1 : 1));
}
