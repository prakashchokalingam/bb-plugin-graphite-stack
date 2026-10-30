// Optional GitHub enrichment through the gh CLI on the environment host.
// gh keeps its own authentication. The plugin never reads or stores tokens,
// and it never prints `gh auth` output.
import type { GhWriteResult } from "../contract";
import type { PrSourceStatus, PrSummary, PrThread } from "./model";
import { graphitePrUrl } from "./parse";
import { stripAnsi, tail, type RunResult, type Runner } from "./process";

export interface GhRepo {
  cwd: string;
  host: string;
  owner: string;
  repo: string;
}

const GH_TIMEOUT = 30_000;

function hostArgs(repo: GhRepo): string[] {
  return repo.host === "github.com" ? [] : ["--hostname", repo.host];
}

/** Classify a failed gh call. Output text is never returned verbatim for auth failures. */
export function classifyGhFailure(result: RunResult): { status: PrSourceStatus; message: string } {
  if (result.spawnError !== null && /ENOENT|not found/iu.test(result.spawnError)) {
    return { status: "gh-missing", message: "GitHub CLI (gh) is not installed on this host" };
  }
  const text = stripAnsi(`${result.stderr}\n${result.stdout}`);
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/iu.test(text)) {
    return { status: "gh-unauthenticated", message: "GitHub CLI is not authenticated on this host. Run `gh auth login` there." };
  }
  if (result.timedOut) return { status: "error", message: "GitHub request timed out" };
  return { status: "error", message: tail(text.trim() || "GitHub request failed", 400) };
}

async function graphql(run: Runner, repo: GhRepo, query: string, variables: Record<string, unknown>, timeoutMs = GH_TIMEOUT) {
  const body = JSON.stringify({ query, variables });
  return run("gh", ["api", ...hostArgs(repo), "graphql", "--input", "-"], {
    cwd: repo.cwd,
    input: body,
    timeoutMs,
    maxBytes: 8 * 1024 * 1024,
  });
}

/** The object at `path` under `data`, or null for a capped, malformed, or partial reply. */
function readData(result: RunResult, path: readonly string[]): Json | null {
  if (result.truncated) return null;
  const parsed = parseJson(result.stdout);
  if (parsed === null || typeof parsed !== "object") return null;
  if (asArr((parsed as Json).errors).length > 0) return null;
  let node: unknown = (parsed as Json).data;
  for (const key of path) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Json)[key];
  }
  return node !== null && typeof node === "object" ? (node as Json) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;
const asObj = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asStr = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNum = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const PR_FIELDS = `number title url state isDraft reviewDecision headRefName headRefOid baseRefName
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** Reads open, merged, and closed PRs for the given head branches in batches. */
export async function listPrs(run: Runner, repo: GhRepo, branches: readonly string[]) {
  const prs: PrSummary[] = [];
  const unique = [...new Set(branches)].slice(0, 500);
  for (let offset = 0; offset < unique.length; offset += 20) {
    const batch = unique.slice(offset, offset + 20);
    const fields = batch
      .map(
        (branch, index) =>
          `b${index}: pullRequests(headRefName: ${JSON.stringify(branch)}, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }`,
      )
      .join("\n");
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const result = await graphql(run, repo, query, { owner: repo.owner, name: repo.repo });
    if (result.exitCode !== 0) return { ...classifyGhFailure(result), prs: [] as PrSummary[] };
    // Fail closed: a capped or malformed reply is an error, never "no PRs".
    const repository = readData(result, ["repository"]);
    if (repository === null) {
      return { status: "error" as const, message: "GitHub returned an incomplete PR list", prs: [] as PrSummary[] };
    }
    batch.forEach((branch, index) => {
      const nodes = asArr(asObj(repository[`b${index}`]).nodes);
      // Prefer an open PR, then the most recently updated one.
      const chosen = nodes.find((node) => asObj(node).state === "OPEN") ?? nodes[0];
      if (chosen === undefined) return;
      const pr = normalizePr(asObj(chosen), repo);
      if (pr !== null && pr.headRefName === branch) prs.push(pr);
    });
  }
  return { status: "ok" as const, message: null, prs };
}

export function normalizePr(node: Json, repo: GhRepo): PrSummary | null {
  const number = asNum(node.number);
  const state = asStr(node.state);
  if (number === null || (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED")) return null;
  const rollup = asStr(
    asObj(asObj(asObj(asArr(asObj(node.commits).nodes)[0]).commit).statusCheckRollup).state,
  );
  const checks =
    rollup === null
      ? "none"
      : rollup === "SUCCESS"
        ? "passing"
        : rollup === "FAILURE" || rollup === "ERROR"
          ? "failing"
          : "pending";
  return {
    number,
    title: asStr(node.title) ?? "",
    url: asStr(node.url) ?? "",
    graphiteUrl: repo.host === "github.com" ? graphitePrUrl(repo.owner, repo.repo, number) : null,
    state,
    isDraft: node.isDraft === true,
    reviewDecision: asStr(node.reviewDecision),
    headRefName: asStr(node.headRefName) ?? "",
    headRefOid: asStr(node.headRefOid) ?? "",
    baseRefName: asStr(node.baseRefName) ?? "",
    checks,
  };
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state headRefOid
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line originalLine startLine diffSide
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes { id databaseId body createdAt url state author { login } }
          }
        }
      }
    }
  }
}`;

export async function listThreads(run: Runner, repo: GhRepo, number: number) {
  const result = await graphql(run, repo, THREADS_QUERY, { owner: repo.owner, name: repo.repo, number });
  if (result.exitCode !== 0) {
    return { ...classifyGhFailure(result), viewer: null, headRefOid: null, state: null, threads: [] as PrThread[], truncated: false };
  }
  const prNode = readData(result, ["repository", "pullRequest"]);
  if (prNode === null) {
    return {
      status: "error" as const,
      message: "GitHub returned an incomplete review thread list",
      viewer: null,
      headRefOid: null,
      state: null,
      threads: [] as PrThread[],
      truncated: false,
    };
  }
  const data = asObj(asObj(parseJson(result.stdout)).data);
  const pr = prNode;
  const reviewThreads = asObj(pr.reviewThreads);
  let commentsTruncated = false;
  const threads: PrThread[] = asArr(reviewThreads.nodes).map((raw) => {
    const node = asObj(raw);
    const side = asStr(node.diffSide);
    return {
      id: asStr(node.id) ?? "",
      isResolved: node.isResolved === true,
      isOutdated: node.isOutdated === true,
      path: asStr(node.path) ?? "",
      line: asNum(node.line),
      originalLine: asNum(node.originalLine),
      startLine: asNum(node.startLine),
      diffSide: side === "LEFT" || side === "RIGHT" ? side : null,
      viewerCanResolve: node.viewerCanResolve === true,
      viewerCanUnresolve: node.viewerCanUnresolve === true,
      viewerCanReply: node.viewerCanReply === true,
      commentsTruncated: (() => {
        const more = asObj(asObj(node.comments).pageInfo).hasNextPage === true;
        if (more) commentsTruncated = true;
        return more;
      })(),
      comments: asArr(asObj(node.comments).nodes).map((rawComment) => {
        const comment = asObj(rawComment);
        return {
          id: asStr(comment.id) ?? "",
          databaseId: asNum(comment.databaseId),
          author: asStr(asObj(comment.author).login) ?? "ghost",
          body: asStr(comment.body) ?? "",
          createdAt: asStr(comment.createdAt) ?? "",
          url: asStr(comment.url),
          state: asStr(comment.state),
        };
      }),
    };
  });
  return {
    status: "ok" as const,
    message: null,
    viewer: asStr(asObj(data.viewer).login),
    headRefOid: asStr(pr.headRefOid),
    state: asStr(pr.state),
    threads: threads.filter((thread) => thread.id !== ""),
    truncated: asObj(reviewThreads.pageInfo).hasNextPage === true || commentsTruncated,
  };
}

/**
 * Classify the result of a write. A timeout, a killed process, or an
 * unparseable success reply is "unknown": the write can have reached GitHub.
 */
function writeOutcome(result: RunResult, extract: (data: Json) => { id: string | null; url: string | null } | null): GhWriteResult {
  if (result.spawnError !== null) return { outcome: "rejected", message: result.spawnError, id: null, url: null };
  if (result.timedOut || result.exitCode === null) {
    return { outcome: "unknown", message: "No reply from GitHub before the timeout. Reconcile before you retry.", id: null, url: null };
  }
  const parsed = asObj(parseJson(result.stdout));
  const errors = asArr(parsed.errors);
  if (result.exitCode !== 0 || errors.length > 0) {
    const first = asStr(asObj(errors[0]).message);
    const failure = classifyGhFailure(result);
    // A 5xx reply is ambiguous; GitHub can still have applied the write.
    if (/HTTP 5\d\d|502|503|504/u.test(`${result.stderr}${result.stdout}`)) {
      return { outcome: "unknown", message: "GitHub returned a server error. Reconcile before you retry.", id: null, url: null };
    }
    return { outcome: "rejected", message: first ?? failure.message, id: null, url: null };
  }
  const extracted = extract(parsed);
  if (extracted === null) {
    return { outcome: "unknown", message: "GitHub reply did not confirm the write. Reconcile before you retry.", id: null, url: null };
  }
  return { outcome: "ok", message: null, ...extracted };
}

export async function replyToThread(run: Runner, repo: GhRepo, threadId: string, body: string): Promise<GhWriteResult> {
  const query = `mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) { comment { id url } }
  }`;
  const result = await graphql(run, repo, query, { threadId, body });
  return writeOutcome(result, (parsed) => {
    const comment = asObj(asObj(asObj(parsed.data).addPullRequestReviewThreadReply).comment);
    const id = asStr(comment.id);
    return id === null ? null : { id, url: asStr(comment.url) };
  });
}

export async function setThreadResolved(run: Runner, repo: GhRepo, threadId: string, resolved: boolean): Promise<GhWriteResult> {
  const name = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const query = `mutation($threadId: ID!) { ${name}(input: {threadId: $threadId}) { thread { id isResolved } } }`;
  const result = await graphql(run, repo, query, { threadId });
  return writeOutcome(result, (parsed) => {
    const thread = asObj(asObj(asObj(parsed.data)[name]).thread);
    const id = asStr(thread.id);
    if (id === null || thread.isResolved !== resolved) return null;
    return { id, url: null };
  });
}

export interface ReviewCommentInput {
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  startLine: number | null;
  body: string;
}

/** One REST call creates and submits the whole review. */
export async function submitReview(
  run: Runner,
  repo: GhRepo,
  number: number,
  commitId: string,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body: string,
  comments: readonly ReviewCommentInput[],
): Promise<GhWriteResult> {
  const payload = {
    commit_id: commitId,
    event,
    body,
    comments: comments.map((comment) => ({
      path: comment.path,
      side: comment.side,
      line: comment.line,
      ...(comment.startLine !== null && comment.startLine < comment.line
        ? { start_line: comment.startLine, start_side: comment.side }
        : {}),
      body: comment.body,
    })),
  };
  const result = await run(
    "gh",
    [
      "api",
      ...hostArgs(repo),
      "--method",
      "POST",
      `repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`,
      "--input",
      "-",
    ],
    { cwd: repo.cwd, input: JSON.stringify(payload), timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 },
  );
  return writeOutcome(result, (parsed) => {
    const id = asNum(parsed.id);
    return id === null ? null : { id: String(id), url: asStr(parsed.html_url) };
  });
}

/** Look for a review whose body contains the marker, to reconcile an unknown write. */
export async function findReviewMarker(run: Runner, repo: GhRepo, number: number, marker: string) {
  const result = await run(
    "gh",
    ["api", ...hostArgs(repo), "--paginate", `repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews?per_page=100`],
    { cwd: repo.cwd, timeoutMs: GH_TIMEOUT, maxBytes: 16 * 1024 * 1024 },
  );
  if (result.exitCode !== 0 || result.truncated) {
    return { status: "error" as const, id: null, url: null, message: classifyGhFailure(result).message };
  }
  // --paginate concatenates JSON arrays: "][" between pages.
  const reviews = parseJson(`[${result.stdout.trim().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\]\s*\[/gu, ",")}]`);
  for (const raw of asArr(reviews)) {
    const review = asObj(raw);
    if ((asStr(review.body) ?? "").includes(marker)) {
      const id = asNum(review.id);
      return { status: "found" as const, id: id === null ? null : String(id), url: asStr(review.html_url), message: null };
    }
  }
  return { status: "not-found" as const, id: null, url: null, message: null };
}
