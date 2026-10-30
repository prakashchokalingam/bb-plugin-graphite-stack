import path from "node:path";
import Database from "better-sqlite3";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { isSemanticRepoChange } from "../host";
import { classifyGhFailure, normalizePr } from "../lib/github";
import type { WorktreeInfo } from "../lib/model";
import { planOperation, summarizeOutcome, type PlanInput } from "../lib/operations";
import { createStore, MIGRATIONS, type Db } from "../lib/store";

function worktree(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: "/r",
    branch: "feature/api",
    headSha: "a".repeat(40),
    detached: false,
    bare: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    operation: null,
    environmentId: "env_main",
    environmentIds: ["env_main"],
    isAnchor: true,
    statusError: null,
    ...overrides,
  };
}

function input(request: PlanInput["request"], overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    request,
    initialized: true,
    trunks: ["main"],
    branches: [
      { name: "main", parent: null, trunk: true, needsRestack: false },
      { name: "feature/model", parent: "main", trunk: false, needsRestack: true },
      { name: "feature/api", parent: "feature/model", trunk: false, needsRestack: false },
      { name: "feature/ui", parent: "feature/model", trunk: false, needsRestack: false },
    ],
    localBranches: new Set(["main", "feature/model", "feature/api", "feature/ui", "plain"]),
    worktrees: [worktree({}), worktree({ path: "/wt-ui", branch: "feature/ui", environmentId: "env_ui", environmentIds: ["env_ui", "env_other_project"], isAnchor: false })],
    anchorPath: "/r",
    busy: new Map(),
    hasRemote: true,
    hasGithubRemote: true,
    ...overrides,
  };
}

describe("planOperation", () => {
  it("blocks stack mutations with an omitted Graphite parent", () => {
    const branches = input({ kind: "sync" }).branches.map((branch) => branch.name === "feature/model" ? { ...branch, parent: "gone" } : branch);
    for (const request of [{ kind: "sync" }, { kind: "restack", branch: "feature/api", scope: "upstack" }, { kind: "submit", branch: "feature/api", stack: true }] as const) {
      expect(planOperation(input(request, { branches })).blockers.join(" ")).toContain("Graphite parent gone");
    }
  });

  it("orders restack steps parent to child and runs each branch in its own worktree", () => {
    const plan = planOperation(input({ kind: "restack", branch: "feature/model", scope: "upstack" }));
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((step) => [step.branch, step.cwd, step.argv.join(" ")])).toEqual([
      ["feature/model", "/r", "gt restack --only --branch feature/model --no-interactive"],
      ["feature/api", "/r", "gt restack --only --branch feature/api --no-interactive"],
      ["feature/ui", "/wt-ui", "gt restack --only --branch feature/ui --no-interactive"],
    ]);
  });

  it("blocks on agents active in any project that shares the worktree", () => {
    const plan = planOperation(input({ kind: "restack", branch: "feature/ui", scope: "only" }, { busy: new Map([["env_other_project", ["Other project agent"]]]) }));
    expect(plan.blockers.join(" ")).toMatch(/Other project agent/u);
  });

  it("treats an unreadable status as a blocker, not a clean tree", () => {
    const plan = planOperation(
      input({ kind: "restack", branch: "feature/api", scope: "only" }, { worktrees: [worktree({ statusError: "git status output exceeded the byte cap" })] }),
    );
    expect(plan.blockers.join(" ")).toMatch(/status is unknown/u);
  });

  it("blocks every action except recovery while a rebase is in progress", () => {
    const worktrees = [worktree({ operation: "rebase", conflicted: 1 })];
    expect(planOperation(input({ kind: "sync" }, { worktrees })).blockers.join(" ")).toMatch(/rebase in progress/u);
    const abort = planOperation(input({ kind: "recover", worktreePath: "/r", action: "abort" }, { worktrees }));
    expect(abort.blockers).toEqual([]);
    expect(abort.steps[0]?.argv).toEqual(["gt", "abort", "--force", "--no-interactive"]);
    const cont = planOperation(input({ kind: "recover", worktreePath: "/r", action: "continue" }, { worktrees }));
    expect(cont.blockers.join(" ")).toMatch(/conflicted/u);
  });

  it("submits drafts without --force and blocks branches that need a restack", () => {
    const plan = planOperation(input({ kind: "submit", branch: "feature/api", stack: false }));
    expect(plan.blockers.join(" ")).toMatch(/feature\/model needs a restack/u);
    const argv = plan.steps[0]!.argv;
    expect(argv).toContain("--draft");
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("-f");
    expect(plan.affected).toEqual(["feature/model", "feature/api"]);
  });

  it("never passes --force or --delete-all to sync and requires a remote", () => {
    expect(planOperation(input({ kind: "sync" }, { hasRemote: false })).blockers.join(" ")).toMatch(/no Git remote/u);
    const plan = planOperation(input({ kind: "sync" }));
    expect(plan.steps[0]?.argv).toEqual(["gt", "sync", "--no-interactive"]);
  });

  it("validates create and track preconditions", () => {
    expect(planOperation(input({ kind: "create", name: "feature/api", message: "m", stageAll: false })).blockers.join(" ")).toMatch(/already exists/u);
    const create = planOperation(input({ kind: "create", name: "feature/new", message: "m", stageAll: false }));
    expect(create.warnings.join(" ")).toMatch(/No staged changes/u);
    expect(create.steps[0]?.argv).toEqual(["gt", "create", "feature/new", "--message", "m", "--no-ai", "--no-interactive"]);
    expect(planOperation(input({ kind: "track", branch: "plain", parent: "nope" })).blockers.join(" ")).toMatch(/not tracked/u);
    expect(planOperation(input({ kind: "track", branch: "feature/api", parent: "main" })).blockers.join(" ")).toMatch(/already tracked/u);
  });

  it("summarizes partial results without claiming success", () => {
    expect(summarizeOutcome([{ status: "done" }, { status: "skipped-by-gt" }] as never)).toBe("partial");
    expect(summarizeOutcome([{ status: "done" }, { status: "conflict" }, { status: "pending" }] as never)).toBe("conflict");
    expect(summarizeOutcome([{ status: "up-to-date" }, { status: "done" }] as never)).toBe("success");
    expect(summarizeOutcome([{ status: "failed" }] as never)).toBe("failed");
  });
});

describe("store", () => {
  function store() {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    return createStore(db as unknown as Db);
  }

  it("keeps replies under their note and deletes them together", () => {
    const s = store();
    const base = { repoKey: "r", branch: "b", path: "a.ts", side: "new" as const, startLine: 1, endLine: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40), lineText: "x", threadId: null };
    const note = s.createNote({ ...base, body: "root", parentId: null });
    s.createNote({ ...base, body: "reply", parentId: note.id });
    expect(s.countNotes("r", "b")).toBe(2);
    expect(s.setNoteResolved(note.id, true)).toBe(true);
    expect(s.getNote(note.id)?.resolved).toBe(true);
    expect(s.deleteNote(note.id)).toBe(true);
    expect(s.listNotes("r", "b")).toEqual([]);
  });

  it("refuses a pending review for a different PR on the same branch", () => {
    const s = store();
    s.ensurePending("r", "b", 1);
    expect(() => s.ensurePending("r", "b", 2)).toThrow(/PR #1/u);
  });

  it("keeps links per repository and branch", () => {
    const s = store();
    s.setLink("r", "b", "thr_1", "env_1");
    s.setLink("r", "b", "thr_2", "env_2");
    expect(s.getLink("r", "b")).toMatchObject({ threadId: "thr_2", environmentId: "env_2" });
    expect(s.listLinks("r")).toHaveLength(1);
    expect(s.deleteLink("r", "b")).toBe(true);
  });
});

describe("repository watcher filter", () => {
  it.each([
    ["refs/heads/feature/api", true],
    ["packed-refs", true],
    ["HEAD", true],
    ["worktrees/ui/HEAD", true],
    ["worktrees/ui/rebase-merge/done", true],
    [".graphite_repo_config", true],
    [".graphite_metadata.db", false],
    [".graphite_metadata.db-wal", false],
    ["index", false],
    ["refs/heads/main.lock", false],
    ["FETCH_HEAD", false],
  ])("%s -> %s", (file, expected) => {
    expect(isSemanticRepoChange(file)).toBe(expected);
  });
});

describe("gh helpers", () => {
  it("classifies auth failures without echoing tool output", () => {
    const failure = classifyGhFailure({ exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", stdoutBytes: 0, truncated: false, timedOut: false, spawnError: null, argv: [] });
    expect(failure.status).toBe("gh-unauthenticated");
    expect(failure.message).not.toContain("To get started");
    const missing = classifyGhFailure({ exitCode: null, stdout: "", stderr: "", stdoutBytes: 0, truncated: false, timedOut: false, spawnError: "spawn gh ENOENT", argv: [] });
    expect(missing.status).toBe("gh-missing");
  });

  it("omits Graphite links for non-github.com hosts", () => {
    const pr = normalizePr({ number: 3, state: "OPEN", title: "t", url: "u", headRefName: "b" }, { cwd: "/", host: "corp.ghe.com", owner: "o", repo: "r" });
    expect(pr?.graphiteUrl).toBeNull();
  });
});

describe("public SDK only", () => {
  it("imports only public SDK entry points", async () => {
    // Third-party UI, test, and database packages are declared dependencies.
    const allow = [/^react(?:-dom)?(?:\/.*)?$/u, /^@radix-ui\//u, /^@testing-library\//u, /^(?:clsx|tailwind-merge|class-variance-authority|sonner|vaul|better-sqlite3)$/u, /^vitest\/config$/u, /^shiki\//u, /^@shikijs\/langs\//u, /^@\//u];
    const result = await experimental_scanPublicSdkOnly(path.resolve(import.meta.dirname, ".."), { allow });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
