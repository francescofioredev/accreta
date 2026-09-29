import { describe, expect, test } from "bun:test";
import { cite } from "../src/source/cite.ts";
import { compileCitationTemplate } from "../src/citations.ts";
import {
  DelegatedSourceError,
  UNPINNED_REVISION,
  formatCitation,
  type LocationVerdict,
  type SourceAdapter,
} from "../src/source/adapter.ts";

const FORMAT = "{source} @ {rev} · {path}#{locator}";

// Scripted rather than fs or git, so cite() cannot lean on which kind of source it holds.
class ScriptedSource implements SourceAdapter {
  pinned: string | undefined;

  constructor(
    readonly id: string,
    private readonly answer: {
      revision: () => Promise<string>;
      locate: () => Promise<LocationVerdict>;
    },
  ) {}

  revision(): Promise<string> {
    return this.answer.revision();
  }

  async changedSince(): Promise<string[]> {
    return [];
  }

  locate(): Promise<LocationVerdict> {
    return this.answer.locate();
  }

  citation(path: string, locator?: string): string {
    return formatCitation(FORMAT, {
      source: this.id,
      rev: this.pinned ?? UNPINNED_REVISION,
      path,
      locator,
    });
  }

  pinRevision(revision: string): void {
    this.pinned = revision;
  }
}

function scripted(
  id: string,
  revision: () => Promise<string>,
  locate: () => Promise<LocationVerdict> = async () => ({ verdict: "found" }),
): ScriptedSource {
  return new ScriptedSource(id, { revision, locate });
}

function sources(...adapters: SourceAdapter[]): Map<string, SourceAdapter> {
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
}

describe("cite", () => {
  test("names the current revision, the verdict, and both citation forms", async () => {
    const docs = scripted("docs", async () => "rev7");
    const result = await cite(sources(docs), FORMAT, {
      sourceId: "docs",
      path: "ch07.md",
      locator: "L3-L9",
    });

    expect(result).toEqual({
      revision: "rev7",
      location: { verdict: "found" },
      footnote: "docs @ rev7 · ch07.md#L3-L9",
      canonicalSource: "docs:ch07.md#L3-L9",
    });
  });

  test("the footnote reads back through the format it was rendered in", async () => {
    const docs = scripted("docs", async () => "rev7");
    const { footnote } = await cite(sources(docs), FORMAT, {
      sourceId: "docs",
      path: "ch07.md",
      locator: "L3-L9",
    });

    const template = compileCitationTemplate(FORMAT);
    if (!template.ok) throw new Error(template.reason);
    expect(template.template.read(footnote)).toEqual({
      sourceId: "docs",
      revision: "rev7",
      path: "ch07.md",
      locator: "L3-L9",
    });
  });

  test("without a locator, neither form carries a dangling #", async () => {
    const docs = scripted("docs", async () => "rev7");
    const result = await cite(sources(docs), FORMAT, { sourceId: "docs", path: "ch07.md" });

    expect(result.footnote).toBe("docs @ rev7 · ch07.md");
    expect(result.canonicalSource).toBe("docs:ch07.md");
  });

  test("never pins the adapter, so an ingest's pinned citations keep their revision", async () => {
    const docs = scripted("docs", async () => "rev8");
    docs.pinRevision("rev7");

    await cite(sources(docs), FORMAT, { sourceId: "docs", path: "ch07.md" });

    expect(docs.pinned).toBe("rev7");
    expect(docs.citation("ch07.md")).toBe("docs @ rev7 · ch07.md");
  });

  test("a missing verdict is passed through, not softened", async () => {
    const missing: LocationVerdict = {
      verdict: "missing",
      part: "locator",
      detail: "past the end",
    };
    const docs = scripted(
      "docs",
      async () => "rev7",
      async () => missing,
    );
    const result = await cite(sources(docs), FORMAT, {
      sourceId: "docs",
      path: "ch07.md",
      locator: "L900",
    });

    expect(result.location).toEqual(missing);
  });

  test("a delegated source says it cannot pin a revision rather than inventing one", async () => {
    const wiki = scripted(
      "wiki",
      async () => {
        throw new DelegatedSourceError("wiki", "notion", "The Design page.");
      },
      async () => ({ verdict: "unknown", detail: "read through notion" }),
    );
    const result = await cite(sources(wiki), FORMAT, {
      sourceId: "wiki",
      path: "design",
      locator: "block-a1",
    });

    expect(result).toEqual({
      revision: null,
      location: { verdict: "unknown", detail: "read through notion" },
      footnote: `wiki @ ${UNPINNED_REVISION} · design#block-a1`,
      canonicalSource: "wiki:design#block-a1",
      delegated: { via: "notion", guidance: "The Design page." },
    });
  });

  test("a revision that fails for any other reason is an error, not a null", async () => {
    const docs = scripted("docs", async () => {
      throw new Error("disk gone");
    });
    await expect(cite(sources(docs), FORMAT, { sourceId: "docs", path: "a.md" })).rejects.toThrow(
      "disk gone",
    );
  });

  test("a locate that throws is unknown, not missing", async () => {
    const docs = scripted(
      "docs",
      async () => "rev7",
      async () => {
        throw new Error("network down");
      },
    );
    const result = await cite(sources(docs), FORMAT, { sourceId: "docs", path: "a.md" });
    expect(result.location).toEqual({ verdict: "unknown", detail: "network down" });
  });

  test("an unconfigured source is refused, naming the ones that are", async () => {
    const docs = scripted("docs", async () => "rev7");
    await expect(cite(sources(docs), FORMAT, { sourceId: "nope", path: "a.md" })).rejects.toThrow(
      'Unknown source "nope". Configured sources: docs.',
    );
  });
});
