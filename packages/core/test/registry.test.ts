import { describe, expect, test } from "bun:test";
import { SourceRegistry, parseSourceDeclaration } from "../src/source/registry.ts";
import type { LineRange, SourceAdapter } from "../src/source/adapter.ts";

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
  async read() {
    return "";
  }
  citation(path: string, lines?: LineRange) {
    return lines ? `${this.id}:${path}#${lines[0]}` : `${this.id}:${path}`;
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
