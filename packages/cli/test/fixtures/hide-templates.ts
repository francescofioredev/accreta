import { plugin } from "bun";

// Preloaded into a spawned CLI: assets resolve to HIDE_TEMPLATES_DIR, so no template is found.
plugin({
  name: "hide-templates",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]assets\.ts$/ }, () => ({
      loader: "ts",
      contents: `export function resolveAsset() { return ${JSON.stringify(process.env.HIDE_TEMPLATES_DIR)}; }`,
    }));
  },
});
