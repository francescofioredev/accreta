import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Runs action.yml's shell steps on a checkout that plants a bunfig.toml preload and a .env. */

const ACTION_PATH = resolve(import.meta.dir, "..");
const KB = "examples/climate";

interface Step {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}

let tmp = "";
let workspace = "";
let runnerTemp = "";
let preloadMarker = "";
let gitTrace = "";

function git(...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: workspace });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

/** The checkout's own files, written where Bun would pick them up if started there. */
function plant(dir: string): void {
  writeFileSync(
    join(dir, "p.ts"),
    `require("node:fs").appendFileSync(${JSON.stringify(preloadMarker)}, process.cwd() + "\\n");\n`,
  );
  writeFileSync(join(dir, "bunfig.toml"), `preload = ["./p.ts"]\n`);
  writeFileSync(join(dir, ".env"), `GIT_TRACE=${gitTrace}\n`);
}

/** Only the expressions action.yml uses; any other one fails the test rather than guessing. */
function expand(value: string): string {
  const known: Record<string, string> = {
    "runner.temp": runnerTemp,
    "github.action_path": ACTION_PATH,
    "github.event.pull_request.head.sha": "",
    "github.event.pull_request.base.sha": "",
    "inputs.working-directory": KB,
    "inputs.github-token": "test-token",
    "inputs.comment-author": "github-actions[bot]",
    "inputs.comment-when-clean == 'true' || steps.drift.outputs.attention != '0'": "false",
  };
  return value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
    if (!(expr in known)) throw new Error(`Unknown expression in action.yml: ${expr}`);
    return known[expr]!;
  });
}

function runStep(step: Step): { code: number; output: string } {
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? tmp,
    GITHUB_ACTION_PATH: ACTION_PATH,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: join(runnerTemp, "output"),
    GITHUB_STEP_SUMMARY: join(runnerTemp, "summary"),
    GITHUB_EVENT_PATH: join(runnerTemp, "event.json"),
  };
  for (const [key, value] of Object.entries(step.env ?? {})) env[key] = expand(value);
  const wd = step["working-directory"];
  const proc = Bun.spawnSync(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!],
    {
      cwd: wd ? resolve(workspace, expand(wd)) : workspace,
      env,
    },
  );
  return { code: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "accreta-action-"));
  workspace = join(tmp, "workspace");
  runnerTemp = join(tmp, "runner-temp");
  preloadMarker = join(tmp, "preload-ran");
  gitTrace = join(tmp, "git-trace");
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, "event.json"), "{}");
  cpSync(join(ACTION_PATH, KB), join(workspace, KB), { recursive: true });
  plant(workspace);
  plant(join(workspace, KB));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=Test", "commit", "-qm", "kb");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("the planted bunfig.toml and .env do take effect on a Bun started in the checkout", () => {
  const proc = Bun.spawnSync([process.execPath, "-e", "console.log(process.env.GIT_TRACE ?? '')"], {
    cwd: join(workspace, KB),
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(proc.stdout.toString().trim()).toBe(gitTrace);
  expect(existsSync(preloadMarker)).toBe(true);
  rmSync(preloadMarker);
});

test("no step of the action lets the checkout configure Bun", () => {
  const action = Bun.YAML.parse(readFileSync(join(ACTION_PATH, "action.yml"), "utf-8")) as {
    runs: { steps: Step[] };
  };
  // An expression in `run` is spliced into the script before the shell parses it.
  for (const step of action.runs.steps) expect(step.run ?? "").not.toContain("${{");

  for (const name of ["Check drift", "Comment on the pull request"]) {
    const step = action.runs.steps.find((s) => s.name === name)!;
    const { code, output } = runStep(step);
    expect({ name, code, output }).toEqual({ name, code: 0, output: expect.any(String) });
  }

  expect(readFileSync(join(runnerTemp, "output"), "utf-8")).toContain("pages-in-doubt=");
  expect({
    preloadRanIn: existsSync(preloadMarker) ? readFileSync(preloadMarker, "utf-8") : "",
    dotenvReachedGit: existsSync(gitTrace),
  }).toEqual({ preloadRanIn: "", dotenvReachedGit: false });
});
