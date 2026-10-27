import { describe, expect, test } from "bun:test";
import {
  SOURCE_ID,
  SourceDeclarationError,
  SourceRegistry,
  parseSourceDeclaration,
} from "../src/source/registry.ts";
import type { LocationVerdict, SourceAdapter } from "../src/source/adapter.ts";

class StubSource implements SourceAdapter {
  constructor(
    readonly id: string,
    readonly options: Record<string, unknown>,
  ) {}
  async revision() {
    return "rev";
  }
  async changedSince() {
    return [];
  }
  async locate(): Promise<LocationVerdict> {
    return { verdict: "found" };
  }
  citation(path: string, locator?: string) {
    return locator ? `${this.id}:${path}#${locator}` : `${this.id}:${path}`;
  }
  // This stub's citations carry no revision, so there is nothing to pin.
  pinRevision() {}
}

describe("parseSourceDeclaration", () => {
  test("id and type are lifted out, everything else is passed through", () => {
    const declaration = parseSourceDeclaration(
      'id: ipcc\ntype: fs\nroot: sources/ipcc\nextensions: [".md"]\n',
    );
    expect(declaration.id).toBe("ipcc");
    expect(declaration.type).toBe("fs");
    expect(declaration.options).toEqual({ root: "sources/ipcc", extensions: [".md"] });
  });

  test("options the core has never heard of survive untouched", () => {
    // The core must not validate adapter options: knowing them is how it starts
    // growing branches per adapter.
    const declaration = parseSourceDeclaration("id: x\ntype: future\nquirk: 42\n");
    expect(declaration.options).toEqual({ quirk: 42 });
  });

  test("a declaration without an id is rejected", () => {
    expect(() => parseSourceDeclaration("type: fs\n")).toThrow(/non-empty `id`/);
  });

  // No citation can name such an id, so it would only ever reach an agent as prose (#362).
  // Format and default-ignorable characters carry text a reader cannot see.
  test.each([
    "my docs",
    "a:b",
    "tab\there",
    "bell\u0007",
    "esc\u001b",
    "tag\u{e0041}\u{e0042}",
    `zero${String.fromCharCode(0x200b)}width`,
    `rlo${String.fromCharCode(0x202e)}`,
    `soft${String.fromCharCode(0xad)}hyphen`,
  ])("an id outside the citation grammar is rejected without being quoted: %p", (id) => {
    const declaration = `id: ${JSON.stringify(id)}\ntype: fs\n`;
    expect(() => parseSourceDeclaration(declaration)).toThrow(/`id` has whitespace/);
    expect(SOURCE_ID.test(id)).toBe(false);
    try {
      parseSourceDeclaration(declaration);
    } catch (error) {
      expect(error).not.toBeInstanceOf(SourceDeclarationError);
      expect((error as Error).message).not.toContain(id);
    }
  });

  test("a declaration without a type is rejected", () => {
    expect(() => parseSourceDeclaration("id: x\n")).toThrow(/non-empty `type`/);
  });
});

describe("SourceRegistry", () => {
  test("an adapter is built from its registered factory", () => {
    const registry = new SourceRegistry().register("fs", (d) => new StubSource(d.id, d.options));
    const adapter = registry.create({ id: "docs", type: "fs", options: { root: "x" } });
    expect(adapter.id).toBe("docs");
  });

  test("an unknown type names the types that are registered", () => {
    const registry = new SourceRegistry().register("fs", (d) => new StubSource(d.id, d.options));
    expect(() => registry.create({ id: "x", type: "http", options: {} })).toThrow(
      /Unknown source type "http".*Registered types: fs/s,
    );
  });

  test("registering a new type requires no change to the registry itself", () => {
    const registry = new SourceRegistry()
      .register("fs", (d) => new StubSource(d.id, d.options))
      .register("carrier-pigeon", (d) => new StubSource(d.id, d.options));
    expect(registry.has("carrier-pigeon")).toBe(true);
  });
});
