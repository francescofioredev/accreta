import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, configFromObject, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex } from "../src/index-db/db.ts";
import { lintKnowledgeBase } from "../src/query/lint.ts";
import { uncitedSentences } from "../src/query/uncited.ts";

const MARK = "(inference)";
const texts = (body: string, marker = MARK) => uncitedSentences(body, marker).map((s) => s.text);

test("a cited sentence and a marked one pass; a bare one is reported", () => {
  const body = [
    "Ice loss lowers albedo.[^a] Absorbed radiation therefore rises (inference).",
    "Warming removes ice and adds warming.",
    "",
    "[^a]: s @ r · f.md#L1",
  ].join("\n");
  expect(texts(body)).toEqual(["Warming removes ice and adds warming."]);
});

test("the marker may follow the full stop, as its own sentence", () => {
  expect(texts("Absorbed radiation rises. (inference)")).toEqual([]);
});

test("a footnote after the marker still counts as marked", () => {
  expect(texts("Absorbed radiation rises (inference).[^a]\n\n[^a]: x")).toEqual([]);
});

test("headings, tables, quotes, code, html and definitions are not prose claims", () => {
  const body = [
    "# A heading with several words",
    "",
    "| a column | another column |",
    "|---|---|",
    "",
    "> A quoted sentence with several words.",
    "",
    "```",
    "code that has several words in it.",
    "```",
    "",
    "<!-- a comment with several words -->",
    "",
    "[^a]: s @ r · f.md#L1 and a long",
    "    continuation of the definition text.",
    "",
    "[ref]: https://example.invalid/a-page",
  ].join("\n");
  expect(texts(body)).toEqual([]);
});

test("list items are sentences; a bare link or a label is not", () => {
  const body = ["- Albedo falls when sea ice melts.", "- [[concepts/albedo]]", "- Albedo"].join(
    "\n",
  );
  expect(uncitedSentences(body, MARK)).toEqual([
    { line: 1, text: "Albedo falls when sea ice melts." },
  ]);
});

test("a sentence is reported at its own line, not its paragraph's first", () => {
  const body = "First line is cited.[^a]\nSecond line is bare and long.\n\n[^a]: x";
  expect(uncitedSentences(body, MARK)).toEqual([
    { line: 2, text: "Second line is bare and long." },
  ]);
});

test("a fence ends a definition, and a multi-line comment is skipped", () => {
  expect(texts("[^a]: x\n\n```\ncode\n```\nProse after the fence here.")).toHaveLength(1);
  expect(texts("<!-- a comment\nwith several words inside -->\n")).toEqual([]);
  expect(texts("<!-- note\n```\n-->\nProse after the comment is long.\n")).toEqual([
    "Prose after the comment is long.",
  ]);
});

test("the marker is configurable", () => {
  expect(texts("Le nubi raffreddano il pianeta (deduzione).", "(deduzione)")).toEqual([]);
  expect(texts("Le nubi raffreddano il pianeta (inference).", "(deduzione)")).toHaveLength(1);
});

test("inference_marker and the lint keys read from config; a blank marker keeps the default", () => {
  expect(DEFAULT_CONFIG.lintUncitedSentences).toBe(false);
  const config = configFromObject({
    provenance: { inference_marker: " (deduzione) " },
    lint: { uncited_sentences: true, uncited_exempt_types: ["source", 3] },
  });
  expect(config.inferenceMarker).toBe("(deduzione)");
  expect(config.lintUncitedSentences).toBe(true);
  expect(config.uncitedExemptTypes).toEqual(["source"]);
  expect(configFromObject({ provenance: { inference_marker: "  " } }).inferenceMarker).toBe(
    "(inference)",
  );
});

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-uncited-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function lintWith(config: AccretaConfig) {
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(
    join(root, "knowledge", "a.md"),
    '---\ntype: note\ncanonical_source: "s:x.md#L1"\nlast_verified_revision: abc\n---\n\n# A\n\nA bare claim with several words.\n',
  );
  writeFileSync(
    join(root, "knowledge", "s.md"),
    '---\ntype: source\ncanonical_source: "s:x.md#L1"\nlast_verified_revision: abc\n---\n\n# S\n\nAnother bare claim here.\n',
  );
  const indexPath = join(root, ".index", "accreta.sqlite");
  buildIndex({ root, config, indexPath });
  const db = openIndex(indexPath, { readonly: true });
  try {
    return await lintKnowledgeBase(db, config, new Map());
  } finally {
    db.close();
  }
}

test("off by default: no finding", async () => {
  const report = await lintWith({ ...DEFAULT_CONFIG, pageTypes: ["note", "source"] });
  expect(report.findings.filter((f) => f.kind === "uncited-sentence")).toEqual([]);
  expect(report.advisoryCount).toBe(0);
});

test("on: one advisory finding per sentence, minus exempt types", async () => {
  const base = { ...DEFAULT_CONFIG, pageTypes: ["note", "source"], lintUncitedSentences: true };
  const all = await lintWith(base);
  expect(all.findings.map((f) => f.path)).toEqual(["knowledge/a.md", "knowledge/s.md"]);
  expect(all.advisoryCount).toBe(2);
  const exempt = await lintWith({ ...base, uncitedExemptTypes: ["source"] });
  expect(exempt.findings.map((f) => f.path)).toEqual(["knowledge/a.md"]);
  expect(exempt.findings[0]!.detail).toContain("body line 3");
});
