#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";

/** Posts `accreta drift --format github` on a pull request as one comment, updated in place. */

export interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

export interface CommentClient {
  list(): Promise<IssueComment[]>;
  create(body: string): Promise<IssueComment>;
  update(id: number, body: string): Promise<void>;
}

export type Outcome = "created" | "updated" | "unchanged" | "skipped";

/** Author of the comment when the workflow's own token posts it. */
export const DEFAULT_AUTHOR = "github-actions[bot]";

/** Keyed by knowledge base, so two of them in one repository keep a comment each. */
export function markerFor(key: string): string {
  // Percent-encoded, `-` included, so no key can close the HTML comment early.
  return `<!-- accreta-drift:${encodeURIComponent(key).replaceAll("-", "%2D")} -->`;
}

/** The report cut to its headline, for when GitHub refuses the full one. */
export function countsOnly(report: string): string {
  const lines = report.trim().split("\n");
  const headline = lines.findIndex((line) => line.startsWith("**"));
  return [
    ...lines.slice(0, headline + 1),
    "",
    "The full report is too long for a comment. It is in this run's job summary.",
  ].join("\n");
}

/**
 * Update the comment that carries `marker` and was written by `author`, or create one. Anyone
 * else's comment carrying the marker, a person's or another app's, is left alone.
 */
export async function upsertComment(
  client: CommentClient,
  marker: string,
  report: string,
  options: { createIfMissing: boolean; author: string; warn?: (message: string) => void },
): Promise<Outcome> {
  const author = options.author.toLowerCase();
  const mine = (await client.list()).find(
    (comment) =>
      comment.user?.login?.toLowerCase() === author && (comment.body ?? "").startsWith(marker),
  );
  if (!mine && !options.createIfMissing) return "skipped";

  const write = async (text: string): Promise<Outcome> => {
    const body = `${marker}\n${text.trim()}\n`;
    if (mine?.body === body) return "unchanged";
    if (mine) {
      await client.update(mine.id, body);
      return "updated";
    }
    const posted = (await client.create(body)).user?.login;
    // Otherwise the next push would not find this comment and post another.
    if (posted && posted.toLowerCase() !== author) {
      options.warn?.(`set comment-author to ${posted}: this token posts as ${posted}.`);
    }
    return "created";
  };
  try {
    return await write(report);
  } catch (error) {
    // 422 is GitHub refusing the body, most likely for its length.
    if (error instanceof GitHubError && error.status === 422) {
      return await write(countsOnly(report));
    }
    throw error;
  }
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** The issue-comments API of one pull request. `fetch` is injectable for tests. */
export function githubClient(options: {
  api: string;
  repository: string;
  pr: number;
  token: string;
  fetch?: typeof fetch;
}): CommentClient {
  const call = options.fetch ?? fetch;
  const base = `${options.api}/repos/${options.repository}/issues`;
  const request = async (url: string, method = "GET", body?: string) => {
    const response = await call(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify({ body }),
    });
    if (!response.ok) {
      throw new GitHubError(
        response.status,
        `${method} ${url}: ${response.status} ${await response.text()}`,
      );
    }
    return response;
  };

  return {
    async list() {
      const all: IssueComment[] = [];
      for (let page = 1; ; page++) {
        const response = await request(`${base}/${options.pr}/comments?per_page=100&page=${page}`);
        const batch = (await response.json()) as IssueComment[];
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
    async create(body) {
      const response = await request(`${base}/${options.pr}/comments`, "POST", body);
      return (await response.json()) as IssueComment;
    },
    async update(id, body) {
      await request(`${base}/comments/${id}`, "PATCH", body);
    },
  };
}

interface PullRequestEvent {
  pull_request?: {
    number: number;
    head?: { repo?: { full_name?: string } | null };
    base?: { repo?: { full_name?: string } };
  };
}

/** Why no comment can be posted from this event, or null when one can. */
export function cannotComment(event: PullRequestEvent): string | null {
  const pr = event.pull_request;
  if (!pr) return "not a pull_request event";
  // A fork's pull_request run gets a read-only token, whatever the workflow asks for.
  if (pr.head?.repo?.full_name !== pr.base?.repo?.full_name) {
    return "the pull request comes from a fork, whose token cannot write";
  }
  return null;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main(): Promise<number> {
  const report = readFileSync(env("DRIFT_REPORT"), "utf-8");
  if (report.trim() === "") throw new Error("accreta drift produced no report.");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${report.trim()}\n`);

  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf-8")) as PullRequestEvent;
  const reason = cannotComment(event);
  if (reason) {
    console.log(`::notice::No comment posted: ${reason}. The report is in the job summary.`);
    return 0;
  }

  const client = githubClient({
    api: process.env.GITHUB_API_URL ?? "https://api.github.com",
    repository: env("GITHUB_REPOSITORY"),
    pr: event.pull_request!.number,
    token: env("GITHUB_TOKEN"),
  });
  try {
    const outcome = await upsertComment(client, markerFor(env("DRIFT_KEY")), report, {
      createIfMissing: process.env.DRIFT_CREATE === "true",
      author: process.env.DRIFT_AUTHOR || DEFAULT_AUTHOR,
      warn: (message) => console.log(`::warning::${message}`),
    });
    console.log(`Drift comment: ${outcome}.`);
  } catch (error) {
    // Dependabot's token is read-only too; the job summary still has the report.
    if (error instanceof GitHubError && error.status === 403) {
      console.log(`::warning::No comment posted, the token cannot write: ${error.message}`);
      return 0;
    }
    throw error;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
