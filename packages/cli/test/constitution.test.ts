import { describe, expect, test } from "bun:test";
import { composeConstitution, isPreset, PRESETS } from "../src/constitution.ts";

describe("composeConstitution", () => {
  test("without a preset it is the method alone", () => {
    const text = composeConstitution();
    expect(text).toContain("Every non-trivial claim carries a citation");
    expect(text).toContain("composed from: base.md");
    expect(text).not.toContain("presets/");
  });

  test("a preset is appended and recorded", () => {
    const text = composeConstitution({ preset: "codebase" });
    expect(text).toContain("Preset: source code");
    expect(text).toContain("composed from: base.md + presets/codebase.md");
  });

  test("the research preset brings its own vocabulary", () => {
    const text = composeConstitution({ preset: "research" });
    expect(text).toContain("contradiction");
    expect(text).toContain("Superseded does not mean deleted");
  });

  test("every preset composes", () => {
    for (const preset of PRESETS) {
      expect(composeConstitution({ preset }).length).toBeGreaterThan(1000);
    }
  });

  test("the base method carries the three non-negotiable rules", () => {
    // If one of these disappears, the constitution has stopped being the
    // program and become documentation about it.
    const text = composeConstitution();
    expect(text).toContain("Never duplicate a source");
    expect(text).toContain("When sources disagree, record the disagreement");
    expect(text).toContain("last_verified_revision");
  });

  test("the base method names the three drift outcomes", () => {
    const text = composeConstitution();
    for (const outcome of ["stale", "unverifiable", "unresolvable"]) {
      expect(text).toContain(outcome);
    }
  });

  test("the generated file says it will not be regenerated", () => {
    // A file an agent is told to edit must not look like something a tool will
    // overwrite.
    expect(composeConstitution()).toContain("nothing regenerates it behind your back");
  });
});

describe("isPreset", () => {
  test("recognizes the shipped presets", () => {
    expect(isPreset("codebase")).toBe(true);
    expect(isPreset("research")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isPreset("climate")).toBe(false);
    expect(isPreset("")).toBe(false);
  });
});
