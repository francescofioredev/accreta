import { describe, expect, test } from "bun:test";
import {
  cannotComment,
  githubClient,
  markerFor,
  upsertComment,
  type CommentClient,
  type IssueComment,
} from "../scripts/drift-comment.ts";

/** Records every write, so a test can assert that nothing was posted twice. */
function fakeClient(existing: IssueComment[]): CommentClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async () => existing,
    create: async (body) => {
      calls.push(`create ${body}`);
    },
    update: async (id, body) => {
      calls.push(`update ${id} ${body}`);
    },
  };
}

const marker = markerFor("examples/climate");
const bot = { type: "Bot" };

describe("upsertComment", () => {
  test("updates the comment that carries the marker rather than posting another", async () => {
    const client = fakeClient([
      { id: 1, body: "a review", user: { type: "User" } },
      { id: 2, body: `${marker}\nold report\n`, user: bot },
    ]);
    expect(await upsertComment(client, marker, "new report", { createIfMissing: true })).toBe(
      "updated",
    );
    expect(client.calls).toEqual([`update 2 ${marker}\nnew report\n`]);
  });

  test("creates the comment when none carries the marker", async () => {
    const client = fakeClient([{ id: 1, body: "a review", user: { type: "User" } }]);
    expect(await upsertComment(client, marker, "report", { createIfMissing: true })).toBe(
      "created",
    );
    expect(client.calls).toEqual([`create ${marker}\nreport\n`]);
  });

  test("with nothing to report and no comment yet, posts nothing", async () => {
    const client = fakeClient([]);
    expect(await upsertComment(client, marker, "clean", { createIfMissing: false })).toBe(
      "skipped",
    );
    expect(client.calls).toEqual([]);
  });

  test("still updates an existing comment once the report is clean", async () => {
    const client = fakeClient([{ id: 7, body: `${marker}\n1 page in doubt\n`, user: bot }]);
    expect(await upsertComment(client, marker, "clean", { createIfMissing: false })).toBe(
      "updated",
    );
    expect(client.calls).toEqual([`update 7 ${marker}\nclean\n`]);
  });

  test("an identical report is not rewritten", async () => {
    const client = fakeClient([{ id: 7, body: `${marker}\nsame\n`, user: bot }]);
    expect(await upsertComment(client, marker, "same", { createIfMissing: true })).toBe(
      "unchanged",
    );
    expect(client.calls).toEqual([]);
  });

  test("a person's comment quoting the marker is never overwritten", async () => {
    const client = fakeClient([{ id: 3, body: `${marker}\nmine`, user: { type: "User" } }]);
    expect(await upsertComment(client, marker, "report", { createIfMissing: true })).toBe(
      "created",
    );
    expect(client.calls).toEqual([`create ${marker}\nreport\n`]);
  });

  test("another knowledge base's comment is not this one", async () => {
    const client = fakeClient([{ id: 4, body: `${markerFor("docs/kb")}\nother`, user: bot }]);
    await upsertComment(client, marker, "report", { createIfMissing: true });
    expect(client.calls).toEqual([`create ${marker}\nreport\n`]);
  });
});

describe("githubClient", () => {
  test("follows pages until a short one, and writes to the right endpoints", async () => {
    const seen: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      const page = Number(new URL(url).searchParams.get("page") ?? 0);
      const size = page === 1 ? 100 : page === 2 ? 1 : 0;
      const body = Array.from({ length: size }, (_, i) => ({ id: page * 1000 + i, body: "" }));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const client = githubClient({
      api: "https://api.example.invalid",
      repository: "owner/repo",
      pr: 12,
      token: "t",
      fetch: fake,
    });

    expect(await client.list()).toHaveLength(101);
    await client.create("x");
    await client.update(5, "y");
    expect(seen).toEqual([
      "GET https://api.example.invalid/repos/owner/repo/issues/12/comments?per_page=100&page=1",
      "GET https://api.example.invalid/repos/owner/repo/issues/12/comments?per_page=100&page=2",
      "POST https://api.example.invalid/repos/owner/repo/issues/12/comments",
      "PATCH https://api.example.invalid/repos/owner/repo/issues/comments/5",
    ]);
  });

  test("a refused write surfaces its status", async () => {
    const fake = (async () =>
      new Response("Resource not accessible by integration", {
        status: 403,
      })) as unknown as typeof fetch;
    const client = githubClient({
      api: "https://api.example.invalid",
      repository: "owner/repo",
      pr: 1,
      token: "t",
      fetch: fake,
    });
    await expect(client.create("x")).rejects.toMatchObject({ status: 403 });
  });
});

const pr = (head: string | null, base: string) => ({
  pull_request: {
    number: 1,
    head: { repo: head === null ? null : { full_name: head } },
    base: { repo: { full_name: base } },
  },
});

describe("cannotComment", () => {
  test("a pull request from a branch of the same repository can be commented on", () => {
    expect(cannotComment(pr("owner/repo", "owner/repo"))).toBeNull();
  });

  test("a fork's pull request cannot, because its token is read-only", () => {
    expect(cannotComment(pr("someone/repo", "owner/repo"))).toMatch(/fork/);
    expect(cannotComment(pr(null, "owner/repo"))).toMatch(/fork/);
  });

  test("an event that is not a pull request cannot", () => {
    expect(cannotComment({})).toMatch(/not a pull_request/);
  });
});
