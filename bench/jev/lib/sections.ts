export interface Section {
  number: string;
  title: string;
  /** 1-based, inclusive, as a `#Lstart-Lend` locator counts them. */
  start: number;
  end: number;
  text: string;
}

// Body headings start at column 0; table-of-contents entries are indented.
const HEADING = /^(?:Appendix\s+)?((?:\d+|[A-Z])(?:\.\d+)*)\.?\s{1,4}(\S.*)$/;
const PAGE_FURNITURE = /^(RFC \d+\s{2,}.*\s{2,}\w+ \d{4}|.*\[Page \d+\])\s*$/;

/** Split an RFC's plain text into numbered sections, keeping line ranges. */
export function splitRfc(text: string): Section[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heads: { i: number; number: string; title: string }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(HEADING);
    if (m && !/\.{4,}\s*\d+\s*$/.test(line) && m[2]!.length < 90)
      heads.push({ i, number: m[1]!, title: m[2]!.trim() });
  });
  return heads.map((h, k) => {
    const endIdx = (heads[k + 1]?.i ?? lines.length) - 1;
    const body = lines
      .slice(h.i, endIdx + 1)
      .filter((l) => !PAGE_FURNITURE.test(l) && !l.includes("\f"));
    return {
      number: h.number,
      title: h.title,
      start: h.i + 1,
      end: endIdx + 1,
      text: body.join("\n").trim(),
    };
  });
}
