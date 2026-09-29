import type { Database } from "../index-db/db.ts";
import { DEFAULT_SUPERSESSION_FIELDS, type AccretaConfig } from "../config.ts";
import type { LintFinding } from "./lint.ts";

const KIND = "inconsistent-supersession";

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
  if (config.supersessionFields === null) return [];
  const fields = config.supersessionFields ?? DEFAULT_SUPERSESSION_FIELDS;
  const { supersedes, supersededBy } = fields;

  const missing = [supersedes, supersededBy].filter((field) => !config.linkFields.includes(field));
  // Unset, a knowledge base without the default pair simply does not use supersession.
  if (missing.length > 0 && !config.supersessionFields) return [];
  if (missing.length > 0) {
    return [
      {
        kind: KIND,
        path: "accreta.config.yaml",
        detail: `supersession_fields names ${missing.join(" and ")}, which link_fields does not list, so supersession is not checked; add it to link_fields, or set supersession_fields to false`,
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
  const loops = stronglyConnected([...next.keys()].toSorted(), next).filter(
    (members) => members.length > 1 || (next.get(members[0]!)?.includes(members[0]!) ?? false),
  );
  loops.forEach((members, id) => {
    for (const page of members) inLoop.set(page, id);
    findings.push({ kind: KIND, path: members[0]!, detail: describeLoop(members, next) });
  });

  for (const claim of claims.values()) {
    const { successor, predecessor } = claim;
    // Inside a loop the claim itself is in doubt, so asking for its reciprocal would be bad advice.
    const loop = inLoop.get(successor);
    if (loop !== undefined && loop === inLoop.get(predecessor)) continue;
    if (claim.bySuccessor && claim.byPredecessor) continue;
    findings.push({
      kind: KIND,
      path: successor < predecessor ? successor : predecessor,
      detail: claim.bySuccessor
        ? `${successor} says ${supersedes}: ${predecessor}, but ${predecessor} has no ${supersededBy} naming ${successor}, so a reader landing on ${predecessor} is not told it was replaced; add it, or drop the claim if no source makes it`
        : `${predecessor} says ${supersededBy}: ${successor}, but ${successor} has no ${supersedes} naming ${predecessor}; add it, or drop the claim if no source makes it`,
    });
  }

  return findings.toSorted((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

function describeLoop(members: string[], next: Map<string, string[]>): string {
  const [first] = members;
  if (members.length === 1) {
    return `${first} claims to supersede itself; a page cannot replace itself, so check the claim`;
  }
  if (members.length === 2) {
    return `${members[0]} and ${members[1]} each claim to supersede the other, so neither reads as the current one; check both claims against their sources`;
  }
  const loop = shortestLoop(first!, new Set(members), next);
  const rest = members.filter((page) => !loop.includes(page));
  const also = rest.length > 0 ? `, and the loop also takes in ${rest.join(", ")}` : "";
  return `${members.length} pages claim to supersede one another in a loop: ${loop.join(" → ")} (each supersedes the next)${also}. Supersession is expected to run one way, so check each claim against its source; if this is a revision history that really loops, record it under a link field that is not a supersession field`;
}

/** The shortest loop from `start` back to itself, walking only `members`. */
function shortestLoop(start: string, members: Set<string>, next: Map<string, string[]>): string[] {
  const parent = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const page = queue[head]!;
    for (const target of next.get(page) ?? []) {
      if (target === start) {
        const path = [page];
        while (path[0] !== start) path.unshift(parent.get(path[0]!)!);
        return [...path, start];
      }
      if (members.has(target) && !parent.has(target)) {
        parent.set(target, page);
        queue.push(target);
      }
    }
  }
  return [start];
}

// Tarjan with an explicit stack: a long chain cannot overflow, and each page and edge is visited once (#80).
function stronglyConnected(pages: string[], next: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const visit = (page: string) => {
    index.set(page, counter);
    low.set(page, counter);
    counter++;
    stack.push(page);
    onStack.add(page);
  };

  for (const start of pages) {
    if (index.has(start)) continue;
    visit(start);
    const work: [string, number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [page, edge] = frame;
      const targets = next.get(page) ?? [];
      if (edge < targets.length) {
        frame[1]++;
        const target = targets[edge]!;
        if (!index.has(target)) {
          visit(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) {
          low.set(page, Math.min(low.get(page)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent[0], Math.min(low.get(parent[0])!, low.get(page)!));
      if (low.get(page) === index.get(page)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== page);
        components.push(component.toSorted());
      }
    }
  }
  return components.toSorted((a, b) => (a[0]! < b[0]! ? -1 : 1));
}
