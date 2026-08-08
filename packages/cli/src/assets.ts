import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Asset = "templates" | "skills";

/**
 * Find a directory that ships alongside the code.
 *
 * Two layouts have to work and they disagree about where the root is. In the
 * repository, `templates/` and `skills/` sit at the top level, three above
 * `src/`. In a published package there is no repository: `prepack` has copied
 * them into the package itself, one level above `src/`.
 *
 * Packed first, and the order is the whole point. Looking in the repository
 * first would let the originals answer for a package that shipped none of
 * them — the failure would appear only on a user's machine, after the version
 * was already on npm and could no longer be republished.
 */
export function resolveAsset(name: Asset): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", name), // published: packages/cli/<name>
    join(here, "..", "..", "..", name), // repository: <root>/<name>
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Cannot find the bundled "${name}" directory. Looked in:\n` +
      candidates.map((candidate) => `  ${candidate}`).join("\n") +
      `\nThis usually means the package was published without its assets, ` +
      `which is to say the prepack copy step did not run.`,
  );
}
