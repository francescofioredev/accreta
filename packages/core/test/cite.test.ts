import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cite } from "../src/source/cite.ts";
import { compileCitationTemplate } from "../src/citations.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { lintCitations } from "../src/query/lint.ts";
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
      locate: (path: string, locator?: string) => Promise<LocationVerdict>;
    },
  ) {}

  revision(): Promise<string> {
    return this.answer.revision();
  }

  async changedSince(): Promise<string[]> {
    return [];
  }

  locate(path: string, locator?: string): Promise<LocationVerdict> {
    return this.answer.locate(path, locator);
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
  locate: (path: string, locator?: string) => Promise<LocationVerdict> = async () => ({
    verdict: "found",
  }),
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
    expect(result.revision).toBeNull();
  });

  test("an unknown verdict gives a null revision, since nothing vouched for the place", async () => {
    const docs = scripted(
      "docs",
      async () => "rev7",
      async () => ({ verdict: "unknown", detail: "a.md has uncommitted changes" }),
    );
    const result = await cite(sources(docs), FORMAT, {
      sourceId: "docs",
      path: "a.md",
      locator: "L5",
    });

    expect(result.revision).toBeNull();
    expect(result.footnote).toBe(`docs @ ${UNPINNED_REVISION} · a.md#L5`);
    expect(result.delegated).toBeUndefined();
  });

  test("the revision is taken before the place is located", async () => {
    const calls: string[] = [];
    const docs = scripted(
      "docs",
      async () => {
        await Promise.resolve();
        calls.push("revision");
        return "rev7";
      },
      async () => (calls.push("locate"), { verdict: "found" }),
    );
    await cite(sources(docs), FORMAT, { sourceId: "docs", path: "a.md" });
    expect(calls).toEqual(["revision", "locate"]);
  });

  test("an empty locator is no locator, in the verdict and in both forms", async () => {
    let asked: string | undefined = "never asked";
    const docs = scripted(
      "docs",
      async () => "rev7",
      async (_path, locator) => {
        asked = locator;
        return { verdict: "found" };
      },
    );
    const result = await cite(sources(docs), FORMAT, {
      sourceId: "docs",
      path: "a.md",
      locator: "",
    });

    expect(asked).toBeUndefined();
    expect(result.footnote).toBe("docs @ rev7 · a.md");
    expect(result.canonicalSource).toBe("docs:a.md");
  });

  test("a source reporting an empty revision is an error, not a pin", async () => {
    for (const bad of ["", undefined]) {
      const docs = scripted("docs", async () => bad as unknown as string);
      await expect(cite(sources(docs), FORMAT, { sourceId: "docs", path: "a.md" })).rejects.toThrow(
        'Source "docs" reported no revision',
      );
    }
  });

  test("an unconfigured source is refused, naming the ones that are", async () => {
    const docs = scripted("docs", async () => "rev7");
    await expect(cite(sources(docs), FORMAT, { sourceId: "nope", path: "a.md" })).rejects.toThrow(
      'Unknown source "nope". Configured sources: docs.',
    );
  });
});

describe("cite refuses what lint and drift cannot read back", () => {
  const docs = () => scripted("docs", async () => "rev7");

  test("a path with whitespace", async () => {
    await expect(
      cite(sources(docs()), FORMAT, { sourceId: "docs", path: "my notes.md" }),
    ).rejects.toThrow('canonical_source "docs:my notes.md" does not read back');
  });

  test("a path carrying a #", async () => {
    await expect(
      cite(sources(docs()), FORMAT, { sourceId: "docs", path: "a.md#x" }),
    ).rejects.toThrow("its path differs");
  });

  test("a path with . or .. segments", async () => {
    for (const path of ["./a.md", "docs/../a.md", ".."]) {
      await expect(cite(sources(docs()), FORMAT, { sourceId: "docs", path })).rejects.toThrow(
        "is not canonical",
      );
    }
  });

  test("a format still using {start} and {end}", async () => {
    // The retired default compiles, but renders its placeholders literally.
    await expect(
      cite(sources(docs()), "{source} @ {rev} · {path}#L{start}-L{end}", {
        sourceId: "docs",
        path: "a.md",
        locator: "L1-L2",
      }),
    ).rejects.toThrow("its locator differs");
    await expect(
      cite(sources(docs()), "{source}:{path}:{start}", { sourceId: "docs", path: "a.md" }),
    ).rejects.toThrow("uses the retired {start} and {end}");
  });

  test("a format without {rev} or {locator} is honoured, not refused", async () => {
    const result = await cite(sources(docs()), "{source} · {path}", {
      sourceId: "docs",
      path: "a.md",
      locator: "L1",
    });
    expect(result.footnote).toBe("docs · a.md");
    expect(result.canonicalSource).toBe("docs:a.md#L1");
  });
});

describe("a delegated footnote under lint", () => {
  let root = "";
  let db: Database | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "accreta-cite-"));
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function lintFootnote(footnote: string) {
    const dir = join(root, DEFAULT_CONFIG.knowledgeBase);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "a.md"),
      `---\ntype: note\n---\n\n# A\n\nA claim.[^a]\n\n[^a]: ${footnote}\n`,
    );
    const indexPath = join(root, ".index", "accreta.sqlite");
    db?.close();
    buildIndex({ root, config: { ...DEFAULT_CONFIG, provenanceFormat: FORMAT }, indexPath });
    db = openIndex(indexPath, { readonly: true });
    return lintCitations(db, sources(wiki));
  }

  const wiki = scripted(
    "wiki",
    async () => {
      throw new DelegatedSourceError("wiki", "notion", "The Design page.");
    },
    async () => ({ verdict: "unknown", detail: "read through notion" }),
  );

  test("is flagged unpinned until the agent substitutes the revision it read", async () => {
    const { footnote } = await cite(sources(wiki), FORMAT, {
      sourceId: "wiki",
      path: "design",
      locator: "block-a1",
    });

    const pasted = await lintFootnote(footnote);
    expect(pasted.findings.map((f) => f.kind)).toEqual(["citation-unpinned"]);

    const substituted = await lintFootnote(footnote.replace(UNPINNED_REVISION, "2026-08-01"));
    expect(substituted.findings).toEqual([]);
    expect(substituted.citationsUnchecked).toBe(1);
  });
});
