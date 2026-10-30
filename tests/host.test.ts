// Host entry against real git and gt in disposable repositories.
import { existsSync } from "node:fs";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostEntry } from "../host";
import { runProcess, type Runner } from "../lib/process";
import { readStack } from "../lib/gitops";
import { git, gt, hasGt, makeStackFixture, tempDir, testRunner, write, type StackFixture } from "./helpers";

const harness = experimental_createHostEntryHarness(createHostEntry(testRunner), {
  experimental_watch: async () => ({ dispose: async () => {} }),
});

afterAll(() => harness.experimental_dispose());

describe.skipIf(!hasGt)("host entry with real gt", () => {
  let fx: StackFixture;
  beforeAll(() => {
    fx = makeStackFixture();
  });

  it("probes git, gt, and Graphite initialization", async () => {
    const probe = await harness.experimental_call("probe", { cwd: fx.root });
    expect(probe.git.available).toBe(true);
    expect(probe.graphite.available).toBe(true);
    expect(probe.graphite.version).toMatch(/^1\.\d+\.\d+$/u);
    expect(probe.graphite.initialized).toBe(true);
    expect(probe.repo?.currentBranch).toBe("feature/api");
    expect(probe.repo?.commonDir).toBe(path.join(fx.root, ".git"));
  });

  it("reads topology with true parents, a fork, multiple commits, and worktrees", async () => {
    const stack = await harness.experimental_call("readStack", {
      cwd: fx.root,
      environmentPaths: [
        { id: "env_main", path: fx.root },
        { id: "env_ui", path: fx.uiWorktree },
      ],
      commitLimit: 50,
    });
    expect(stack.ok).toBe(true);
    expect(stack.trunks).toEqual(["main"]);
    const byName = Object.fromEntries(stack.branches.map((branch) => [branch.name, branch]));
    expect(byName["feature/model"]).toMatchObject({ parent: "main", commitCount: 2 });
    expect(byName["feature/model"]?.commits.map((commit) => commit.subject)).toEqual(["model: order test", "model: order type"]);
    expect(byName["feature/api"]).toMatchObject({ parent: "feature/model", commitCount: 1 });
    expect(byName["feature/ui"]).toMatchObject({ parent: "feature/model", commitCount: 1 });
    expect(stack.localBranches).toEqual(["plain"]);
    const ui = stack.worktrees.find((worktree) => worktree.branch === "feature/ui");
    expect(ui).toMatchObject({ path: fx.uiWorktree, environmentId: "env_ui", environmentIds: ["env_ui"] });
    expect(stack.worktrees.find((worktree) => worktree.isAnchor)?.environmentId).toBe("env_main");
    expect(stack.remote).toBeNull();
  });

  it("reads topology without details, then reads only the requested branch and worktree", async () => {
    const commands: { command: string; args: readonly string[]; cwd: string }[] = [];
    const runner: Runner = (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      return testRunner(command, args, options);
    };
    const skeleton = await readStack(runner, fx.root, [], 50, []);
    expect(skeleton.ok).toBe(true);
    expect(skeleton.branches.every((branch) => branch.detailsLoaded === false)).toBe(true);
    expect(commands.filter((call) => call.command === "git" && ["log", "status"].includes(call.args[0] ?? ""))).toEqual([]);
    commands.length = 0;
    const detail = await readStack(runner, fx.root, [], 50, ["feature/ui"]);
    expect(detail.branches.find((branch) => branch.name === "feature/ui")).toMatchObject({ detailsLoaded: true, commitCount: 1 });
    expect(detail.branches.find((branch) => branch.name === "feature/api")?.detailsLoaded).toBe(false);
    expect(detail.worktrees.find((worktree) => worktree.branch === "feature/api")?.statusError).toBe("Status not loaded");
    expect(commands.filter((call) => call.command === "git" && call.args[0] === "log")).toHaveLength(1);
    expect(commands.filter((call) => call.command === "git" && call.args[0] === "status").map((call) => call.cwd)).toEqual([fx.uiWorktree]);
  });

  it("lists only each layer's own changes against its Graphite parent", async () => {
    const api = await harness.experimental_call("layerFiles", { cwd: fx.root, branch: "feature/api", parent: "feature/model", maxFiles: 100 });
    expect(api.error).toBeNull();
    const byPath = Object.fromEntries(api.files.map((file) => [file.path, file]));
    expect(Object.keys(byPath).sort()).toEqual(["-notes.md", "big.txt", "gone.txt", "img.bin", "src/a[1].ts", "src/checkout.ts", "src/renamed.ts"]);
    expect(byPath["src/renamed.ts"]).toMatchObject({ status: "R", oldPath: "src/old.ts" });
    expect(byPath["gone.txt"]?.status).toBe("D");
    expect(byPath["img.bin"]?.binary).toBe(true);
    expect(byPath["src/order.ts"]).toBeUndefined();
    const model = await harness.experimental_call("layerFiles", { cwd: fx.root, branch: "feature/model", parent: "main", maxFiles: 100 });
    expect(model.files.map((file) => file.path).sort()).toEqual(["src/order.test.ts", "src/order.ts"]);
    expect(model.snapshot?.diverged).toBe(false);
  });

  it("reads one exact file patch for names that look like pathspec magic", async () => {
    const api = await harness.experimental_call("layerFiles", { cwd: fx.root, branch: "feature/api", parent: "feature/model", maxFiles: 100 });
    const { baseSha, headSha } = api.snapshot!;
    for (const file of ["src/a[1].ts", "-notes.md"]) {
      const patch = await harness.experimental_call("filePatch", { cwd: fx.root, baseSha, headSha, path: file, oldPath: null, maxBytes: 65536 });
      expect(patch.patch).toContain(`+++ b/${file}`);
      expect((patch.patch.match(/^diff --git/gmu) ?? []).length).toBe(1);
    }
    const rename = await harness.experimental_call("filePatch", { cwd: fx.root, baseSha, headSha, path: "src/renamed.ts", oldPath: "src/old.ts", maxBytes: 65536 });
    expect(rename.patch).toContain("rename from src/old.ts");
    const binary = await harness.experimental_call("filePatch", { cwd: fx.root, baseSha, headSha, path: "img.bin", oldPath: null, maxBytes: 65536 });
    expect(binary.binary).toBe(true);
    const deleted = await harness.experimental_call("filePatch", { cwd: fx.root, baseSha, headSha, path: "gone.txt", oldPath: null, maxBytes: 65536 });
    expect(deleted.patch).toContain("deleted file mode");
  });

  it("caps patch bytes and file sides", async () => {
    const api = await harness.experimental_call("layerFiles", { cwd: fx.root, branch: "feature/api", parent: "feature/model", maxFiles: 100 });
    const { baseSha, headSha } = api.snapshot!;
    const patch = await harness.experimental_call("filePatch", { cwd: fx.root, baseSha, headSha, path: "big.txt", oldPath: null, maxBytes: 4096 });
    expect(patch.truncated).toBe(true);
    expect(patch.patch.length).toBeLessThanOrEqual(4096);
    expect(patch.bytes).toBeGreaterThan(4096);
    const sides = await harness.experimental_call("fileSides", { cwd: fx.root, baseSha, headSha, path: "big.txt", oldPath: null, maxBytes: 4096 });
    expect(sides.status).toBe("too-large");
    const binary = await harness.experimental_call("fileSides", { cwd: fx.root, baseSha, headSha, path: "img.bin", oldPath: null, maxBytes: 65536 });
    expect(binary.status).toBe("binary");
    const added = await harness.experimental_call("fileSides", { cwd: fx.root, baseSha, headSha, path: "src/checkout.ts", oldPath: null, maxBytes: 65536 });
    expect(added).toMatchObject({ status: "ok", old: { content: "" }, new: { content: "export function checkout() {\n  return 1;\n}\n" } });
  });

  it("rejects invalid refs and unknown commits", async () => {
    await expect(harness.experimental_call("snapshot", { cwd: fx.root, branch: "-x", parent: "main" })).rejects.toThrow();
    const missing = await harness.experimental_call("snapshot", { cwd: fx.root, branch: "nope", parent: "main" });
    expect(missing.snapshot).toBeNull();
    const ghost = "0123456789abcdef0123456789abcdef01234567";
    await expect(
      harness.experimental_call("filePatch", { cwd: fx.root, baseSha: ghost, headSha: ghost, path: "README.md", oldPath: null, maxBytes: 4096 }),
    ).rejects.toThrow(/not available/u);
    await expect(
      harness.experimental_call("filePatch", { cwd: fx.root, baseSha: "HEAD", headSha: "HEAD", path: "README.md", oldPath: null, maxBytes: 4096 } as never),
    ).rejects.toThrow();
    await expect(
      harness.experimental_call("filePatch", { cwd: fx.root, baseSha: ghost, headSha: ghost, path: "../etc/passwd", oldPath: null, maxBytes: 4096 }),
    ).rejects.toThrow();
  });

  it("detects outdated full-range anchors", async () => {
    const snap = (await harness.experimental_call("snapshot", { cwd: fx.root, branch: "feature/api", parent: "feature/model" })).snapshot!;
    const anchors = [
      { id: "range", path: "src/checkout.ts", side: "new" as const, startLine: 1, endLine: 2, text: "export function checkout() {\n  return 1;" },
      { id: "wrong", path: "src/checkout.ts", side: "new" as const, startLine: 1, endLine: 2, text: "export function checkout() {\n  return 2;" },
      { id: "old", path: "src/old.ts", side: "old" as const, startLine: 1, endLine: 1, text: "export const legacy = 1;" },
    ];
    const result = await harness.experimental_call("checkAnchors", { cwd: fx.root, baseSha: snap.baseSha, headSha: snap.headSha, anchors });
    expect(result.results).toEqual({ range: "current", wrong: "outdated", old: "current" });
  });

  it("reports uncommitted changes separately from committed layer changes", async () => {
    write(fx.uiWorktree, "src/ui.tsx", "export const Ui = () => 'changed';\n");
    write(fx.uiWorktree, "scratch.txt", "draft\n");
    const status = await harness.experimental_call("uncommitted", { cwd: fx.root, worktreePath: fx.uiWorktree, maxFiles: 100 });
    expect(status.branch).toBe("feature/ui");
    expect(status.files.map((file) => [file.path, file.untracked])).toEqual([
      ["src/ui.tsx", false],
      ["scratch.txt", true],
    ]);
    const patch = await harness.experimental_call("uncommittedPatch", { cwd: fx.root, worktreePath: fx.uiWorktree, path: "scratch.txt", untracked: true, maxBytes: 4096 });
    expect(patch.patch).toContain("+draft");
    const layer = await harness.experimental_call("layerFiles", { cwd: fx.root, branch: "feature/ui", parent: "feature/model", maxFiles: 100 });
    expect(layer.files.map((file) => file.path)).toEqual(["src/ui.tsx"]);
    git(fx.uiWorktree, "checkout", "-q", "--", "src/ui.tsx");
    git(fx.uiWorktree, "clean", "-qf");
  });

  it("never initializes Graphite during reads", async () => {
    const root = tempDir("gs-uninit-");
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "-q", "--allow-empty", "-m", "init");
    const probe = await harness.experimental_call("probe", { cwd: root });
    expect(probe.graphite.initialized).toBe(false);
    const topology = await harness.experimental_call("topology", { cwd: root });
    expect(topology).toMatchObject({ ok: false, errorKind: "uninitialized" });
    const stack = await harness.experimental_call("readStack", { cwd: root, environmentPaths: [], commitLimit: 5 });
    expect(stack.ok).toBe(false);
    expect(existsSync(path.join(root, ".git", ".graphite_repo_config"))).toBe(false);
  });

  it("refuses invalid branch names in gt commands before running gt", async () => {
    await expect(
      harness.experimental_call("gt", { cwd: fx.root, command: { kind: "track", branch: "--force", parent: "main" }, timeoutMs: 10_000 }),
    ).rejects.toThrow();
  });

  it("reports a non-repository directory", async () => {
    const dir = tempDir("gs-plain-");
    const probe = await harness.experimental_call("probe", { cwd: dir });
    expect(probe.repo).toBeNull();
    expect(probe.git.available).toBe(true);
  });
});

describe("process runner", () => {
  it("does not start a process after the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess("git", ["--version"], { cwd: process.cwd(), signal: controller.signal });
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const result = await runProcess("sh", ["-c", "sleep 30 & sleep 30"], { cwd: process.cwd(), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("caps stdout bytes", async () => {
    const result = await runProcess("sh", ["-c", "yes x | head -c 100000"], { cwd: process.cwd(), maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1000);
    expect(result.stdoutBytes).toBe(100000);
  });

  it("reports a missing binary", async () => {
    const result = await runProcess("definitely-not-a-binary-gs", [], { cwd: process.cwd() });
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).not.toBeNull();
  });
});
