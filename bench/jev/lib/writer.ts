import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cached } from "./cache.ts";

const CWD = join(tmpdir(), "accreta-bench-haiku");

/** One structured text generation through the `claude` CLI in safe mode, cached by its full input. */
export function writeText(
  namespace: string,
  model: string,
  system: string,
  input: string,
  field: string,
): Promise<{ text: string; cost_usd: number; error?: string }> {
  const schema = {
    type: "object",
    properties: { [field]: { type: "string" } },
    required: [field],
    additionalProperties: false,
  };
  return cached(
    namespace,
    { model, system, input, field },
    () =>
      new Promise((resolve) => {
        mkdirSync(CWD, { recursive: true });
        const args = [
          "-p",
          "--safe-mode",
          "--model",
          model,
          "--tools",
          "",
          "--output-format",
          "json",
          "--system-prompt",
          system,
          "--json-schema",
          JSON.stringify(schema),
        ];
        const child = spawn("claude", args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", () => {
          try {
            const d = JSON.parse(out);
            resolve({
              text: (d.structured_output ?? JSON.parse(d.result))[field],
              cost_usd: d.total_cost_usd ?? 0,
            });
          } catch (e) {
            resolve({ text: "", cost_usd: 0, error: String(e) });
          }
        });
        child.stdin.end(input);
      }),
    (v) => !v.error && !!v.text,
  );
}
