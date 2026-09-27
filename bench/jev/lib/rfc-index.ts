import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL } from "./paths.ts";

export interface RfcEntry {
  id: string;
  title: string;
  abstract: string;
  keywords: string[];
  status: string;
  date: string;
  obsoletes: string[];
  obsoletedBy: string[];
  updates: string[];
  updatedBy: string[];
}

const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
const docIds = (xml: string, name: string) =>
  [...tag(xml, name).matchAll(/<doc-id>(RFC\d+)<\/doc-id>/g)].map((m) => m[1]!);
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

let memo: Map<string, RfcEntry> | undefined;

/** The RFC Editor's index, parsed without an XML dependency: the format is flat and stable. */
export function rfcIndex(): Map<string, RfcEntry> {
  if (memo) return memo;
  const xml = readFileSync(join(EXTERNAL, "rfc", "index.xml"), "utf8");
  memo = new Map();
  for (const m of xml.matchAll(/<rfc-entry>([\s\S]*?)<\/rfc-entry>/g)) {
    const e = m[1]!;
    const id = tag(e, "doc-id");
    memo.set(id, {
      id,
      title: text(tag(e, "title")),
      abstract: text(tag(e, "abstract")),
      keywords: [...tag(e, "keywords").matchAll(/<kw>([\s\S]*?)<\/kw>/g)].map((k) => text(k[1]!)),
      status: text(tag(e, "current-status")),
      date: `${text(tag(tag(e, "date"), "year"))}-${text(tag(tag(e, "date"), "month"))}`,
      obsoletes: docIds(e, "obsoletes"),
      obsoletedBy: docIds(e, "obsoleted-by"),
      updates: docIds(e, "updates"),
      updatedBy: docIds(e, "updated-by"),
    });
  }
  return memo;
}
