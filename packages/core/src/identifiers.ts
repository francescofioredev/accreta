const SEPARATOR = /[^\p{L}\p{N}\p{M}_]+/u;
const WORD = /[\p{L}\p{N}]/u;

/** The runs of letters, digits and marks with an underscore in them, in order, repeats kept. */
export function identifiersIn(text: string): string[] {
  // Most pages have no underscore, and a split per page is what the rebuild would pay for them.
  if (!text.includes("_")) return [];
  return text.split(SEPARATOR).filter((run) => run.includes("_") && WORD.test(run));
}
