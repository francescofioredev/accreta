import { describe, expect, test } from "bun:test";
import { DelegatedSourceError, UNPINNED_REVISION } from "@accreta/core";
import { DelegatedSource } from "../src/index.ts";

const SCOPE = "The Design decisions page and everything below it.";

function source(overrides: Partial<{ via: string; scope: string }> = {}) {
  return new DelegatedSource({
    id: "design-docs",
    via: overrides.via ?? "notion",
    scope: overrides.scope ?? SCOPE,
    citationFormat: "{source} @ {rev} · {path}#{locator}",
  });
}

describe("DelegatedSource", () => {
  test("asking for a revision raises rather than returning one", async () => {
    // A sentinel revision would let every caller carry on as if an answer had
    // been given, which is the whole failure this adapter exists to avoid.
    expect(source().revision()).rejects.toThrow(DelegatedSourceError);
  });

  test("asking what changed raises the same way", async () => {
    expect(source().changedSince("2026-08-01T10:22:00Z")).rejects.toThrow(DelegatedSourceError);
  });

  test("the error carries what the agent needs to act", async () => {
    let error: DelegatedSourceError | undefined;
    try {
      await source().revision();
    } catch (caught) {
      error = caught as DelegatedSourceError;
    }

    expect(error?.sourceId).toBe("design-docs");
    expect(error?.via).toBe("notion");
    expect(error?.guidance).toBe(SCOPE);
  });

  test("locate is unknown, never missing", async () => {
    // Saying a citation is broken because nobody looked would be worse than
    // saying nothing, and it is what a two-valued verdict would have forced.
    const verdict = await source().locate("2f1a4b", "block-a1b2c3");
    expect(verdict.verdict).toBe("unknown");
  });

  test("citations render exactly as any other source's do", () => {
    const docs = source();
    docs.pinRevision("2026-08-01T10:22:00Z");
    expect(docs.citation("2f1a4b", "block-a1b2c3")).toBe(
      "design-docs @ 2026-08-01T10:22:00Z · 2f1a4b#block-a1b2c3",
    );
  });

  test("an unpinned citation names the shared sentinel", () => {
    expect(source().citation("2f1a4b")).toContain(UNPINNED_REVISION);
  });

  test("a declaration with no scope is refused, not defaulted", () => {
    // An empty scope tells the agent to check "the connector", which is either
    // nothing or everything. A startup error naming the file to fix is better
    // than either.
    expect(() => source({ scope: "   " })).toThrow(/declares no `scope`/);
  });

  test("a declaration with no connector is refused", () => {
    expect(() => source({ via: "" })).toThrow(/declares no `via`/);
  });
});
