// PR review flow with a stubbed gh. git and gt are real; GitHub is not
// contacted, and no shared write leaves the test process.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunResult, Runner } from "../lib/process";
import { git, hasGt, makeStackFixture, testRunner, write, type StackFixture } from "./helpers";
import { makeEnvironment, startServer, thread, type World } from "./server-harness.test";

interface GhState {
  mode: "ok" | "unknown" | "reject";
  delayMs: number;
  posts: { path: string; payload: any }[];
  postedMarkers: string[];
  prHead: () => string;
}

function ok(stdout: unknown, argv: string[]): RunResult {
  return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: "", stdoutBytes: 0, truncated: false, timedOut: false, spawnError: null, argv };
}

function ghStub(state: GhState): Runner {
  return async (command, args, options) => {
    if (command !== "gh") return testRunner(command, args, options);
    const argv = [command, ...args];
    if (args.includes("graphql")) {
      const { query } = JSON.parse(options.input ?? "{}") as { query: string };
      if (query.includes("pullRequests(headRefName")) {
        const repository: Record<string, unknown> = {};
        for (const match of query.matchAll(/b(\d+): pullRequests\(headRefName: "([^"]+)"/gu)) {
          repository[`b${match[1]}`] = {
            nodes:
              match[2] === "feature/api"
                ? [
                    {
                      number: 7,
                      title: "API",
                      url: "https://github.com/acme/demo/pull/7",
                      state: "OPEN",
                      isDraft: true,
                      reviewDecision: null,
                      headRefName: "feature/api",
                      headRefOid: state.prHead(),
                      baseRefName: "feature/model",
                      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
                    },
                  ]
                : [],
          };
        }
        return ok({ data: { repository } }, argv);
      }
      if (query.includes("reviewThreads")) {
        return ok(
          {
            data: {
              viewer: { login: "me" },
              repository: {
                pullRequest: {
                  state: "OPEN",
                  headRefOid: state.prHead(),
                  reviewThreads: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        id: "PRRT_1",
                        isResolved: false,
                        isOutdated: false,
                        path: "src/checkout.ts",
                        line: 1,
                        originalLine: 1,
                        startLine: null,
                        diffSide: "RIGHT",
                        viewerCanResolve: true,
                        viewerCanUnresolve: false,
                        viewerCanReply: true,
                        comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "C1", databaseId: 1, body: "Shared comment", createdAt: "2026-10-29T00:00:00Z", url: null, state: "SUBMITTED", author: { login: "mira" } }] },
                      },
                    ],
                  },
                },
              },
            },
          },
          argv,
        );
      }
      if (query.includes("addPullRequestReviewThreadReply")) {
        return ok({ data: { addPullRequestReviewThreadReply: { comment: { id: "C2", url: "https://github.com/acme/demo/pull/7#c2" } } } }, argv);
      }
      if (query.includes("resolveReviewThread")) {
        return ok({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } }, argv);
      }
    }
    const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("POST") && endpoint.endsWith("/reviews")) {
      const payload = JSON.parse(options.input ?? "{}");
      state.posts.push({ path: endpoint, payload });
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.mode === "unknown") {
        // The write reached GitHub, but the reply was lost.
        state.postedMarkers.push(String(/bb-graphite-stack:review:[0-9a-f-]+/u.exec(payload.body)?.[0]));
        return { exitCode: null, stdout: "", stderr: "", stdoutBytes: 0, truncated: false, timedOut: true, spawnError: null, argv };
      }
      if (state.mode === "reject") {
        return { exitCode: 1, stdout: JSON.stringify({ message: "Unprocessable Entity" }), stderr: "gh: HTTP 422: line must be part of the diff", stdoutBytes: 0, truncated: false, timedOut: false, spawnError: null, argv };
      }
      return ok({ id: 99, html_url: "https://github.com/acme/demo/pull/7#pullrequestreview-99" }, argv);
    }
    if (endpoint.includes("/reviews?per_page")) {
      return ok(state.postedMarkers.map((marker, index) => ({ id: 100 + index, body: `x\n<!-- ${marker} -->`, html_url: `https://github.com/acme/demo/pull/7#r${index}` })), argv);
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected gh call ${args.join(" ")}`, stdoutBytes: 0, truncated: false, timedOut: false, spawnError: null, argv };
  };
}

describe.skipIf(!hasGt)("PR review flow with stubbed gh", () => {
  let fx: StackFixture;
  let server: Awaited<ReturnType<typeof startServer>>;
  const state: GhState = { mode: "ok", delayMs: 0, posts: [], postedMarkers: [], prHead: () => "" };
  const env = { environmentId: "env_main", branch: "feature/api" };

  async function anchor(startLine = 1, endLine = 1) {
    const files = await server.call("layerFiles", env);
    return { path: "src/checkout.ts", side: "new", startLine, endLine, baseSha: files.snapshot.baseSha, headSha: files.snapshot.headSha };
  }

  beforeAll(async () => {
    fx = makeStackFixture({ remote: "https://github.com/acme/demo.git" });
    state.prHead = () => git(fx.root, "rev-parse", "refs/heads/feature/api");
    const w: World = { environments: new Map([["env_main", makeEnvironment("env_main", fx.root)]]), threads: new Map([["thr_main", thread("thr_main", "env_main")]]), running: new Set() };
    server = await startServer(w, ghStub(state));
  });
  afterAll(() => server.dispose());
  beforeEach(() => {
    state.mode = "ok";
    state.delayMs = 0;
    state.posts = [];
  });

  it("enriches local layers with PR data and canonical Graphite links", async () => {
    const prs = await server.call("prs", { environmentId: "env_main", refresh: true });
    expect(prs.status).toBe("ok");
    expect(prs.prs["feature/api"]).toMatchObject({ number: 7, isDraft: true, checks: "passing", graphiteUrl: "https://app.graphite.com/github/pr/acme/demo/7" });
    expect(prs.prs["feature/model"]).toBeUndefined();
  });

  it("reads, replies to, and resolves PR review threads", async () => {
    const threads = await server.call("prThreads", env);
    expect(threads.pr.number).toBe(7);
    expect(threads.threads[0]).toMatchObject({ id: "PRRT_1", commentsTruncated: false });
    expect(await server.call("prReply", { ...env, threadId: "PRRT_1", body: "Thanks" })).toMatchObject({ outcome: "ok" });
    expect(await server.call("prSetResolved", { ...env, threadId: "PRRT_1", resolved: true })).toMatchObject({ outcome: "ok" });
  });

  it("submits only pending PR comments, never private notes", async () => {
    await server.call("noteCreate", { ...env, anchor: await anchor(), body: "PRIVATE-NOTE-BODY", threadId: null });
    await server.call("pendingAdd", { ...env, anchor: await anchor(1, 2), body: "Shared: rename this" });
    await server.call("pendingSetBody", { ...env, body: "Looks close" });
    const result = await server.call("submitReview", { ...env, event: "REQUEST_CHANGES" });
    expect(result.outcome).toBe("ok");
    expect(result.pending).toBeNull();
    expect(state.posts).toHaveLength(1);
    const { payload, path } = state.posts[0]!;
    expect(path).toBe("repos/acme/demo/pulls/7/reviews");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE-NOTE-BODY");
    expect(payload).toMatchObject({ event: "REQUEST_CHANGES", commit_id: state.prHead() });
    expect(payload.body).toMatch(/^Looks close\n\n<!-- bb-graphite-stack:review:/u);
    expect(payload.comments).toEqual([{ path: "src/checkout.ts", side: "RIGHT", line: 2, start_line: 1, start_side: "RIGHT", body: "Shared: rename this" }]);
    const notes = await server.call("notesList", env);
    expect(notes.notes.map((note: { body: string }) => note.body)).toContain("PRIVATE-NOTE-BODY");
  });

  it("keeps the draft after a rejected submit", async () => {
    await server.call("pendingAdd", { ...env, anchor: await anchor(), body: "Rejected comment" });
    state.mode = "reject";
    const result = await server.call("submitReview", { ...env, event: "COMMENT" });
    expect(result.outcome).toBe("rejected");
    expect(result.pending.comments.map((comment: { body: string }) => comment.body)).toEqual(["Rejected comment"]);
    expect(result.pending.lastError).toMatch(/part of the diff/u);
    expect(result.pending.submission).toBeNull();
  });

  it("never retries an ambiguous write blindly and reconciles by marker", async () => {
    state.mode = "unknown";
    const first = await server.call("submitReview", { ...env, event: "COMMENT" });
    expect(first.outcome).toBe("unknown");
    expect(first.pending.submission.state).toBe("unknown");
    state.mode = "ok";
    const blocked = await server.call("submitReview", { ...env, event: "COMMENT" });
    expect(blocked.outcome).toBe("blocked");
    await expect(server.call("pendingAdd", { ...env, anchor: await anchor(), body: "x" })).rejects.toThrow(/Reconcile/u);
    expect(state.posts).toHaveLength(1);
    const reconciled = await server.call("reconcileReview", env);
    expect(reconciled.outcome).toBe("posted");
    expect(reconciled.pending).toBeNull();
  });

  it("allows a new submit after reconcile finds no review", async () => {
    await server.call("pendingAdd", { ...env, anchor: await anchor(), body: "Lost comment" });
    state.mode = "unknown";
    await server.call("submitReview", { ...env, event: "COMMENT" });
    state.postedMarkers.pop(); // The write never reached GitHub.
    const reconciled = await server.call("reconcileReview", env);
    expect(reconciled.outcome).toBe("not-posted");
    expect(reconciled.pending.submission).toBeNull();
    state.mode = "ok";
    expect((await server.call("submitReview", { ...env, event: "COMMENT" })).outcome).toBe("ok");
  });

  it("serializes concurrent submits so only one write reaches GitHub", async () => {
    await server.call("pendingAdd", { ...env, anchor: await anchor(), body: "Once" });
    state.delayMs = 300;
    const results = await Promise.allSettled([
      server.call("submitReview", { ...env, event: "COMMENT" }),
      server.call("submitReview", { ...env, event: "COMMENT" }),
    ]);
    expect(state.posts).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled" && (result.value as { outcome: string }).outcome === "ok")).toHaveLength(1);
    expect(results.some((result) => result.status === "rejected" && /already running/u.test(String(result.reason)))).toBe(true);
  });

  it("revalidates anchors and the head before submit", async () => {
    await server.call("pendingAdd", { ...env, anchor: await anchor(), body: "Will be outdated" });
    write(fx.root, "src/checkout.ts", "export function checkoutV2() {\n  return 1;\n}\n");
    git(fx.root, "commit", "-qam", "api: rename");
    const result = await server.call("submitReview", { ...env, event: "COMMENT" });
    expect(result.outcome).toBe("blocked");
    expect(result.message).toMatch(/outdated/u);
    expect(state.posts).toHaveLength(0);
    const original = state.prHead;
    state.prHead = () => "f".repeat(40);
    const mismatch = await server.call("submitReview", { ...env, event: "COMMENT" });
    expect(mismatch.message).toMatch(/differs from the PR head/u);
    state.prHead = original;
  });
});
