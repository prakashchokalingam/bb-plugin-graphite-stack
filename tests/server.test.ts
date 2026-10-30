// Server RPC behavior against real git and gt in disposable repositories.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperationPreview, OperationResult, StackView } from "../contract";
import { git, gt, hasGt, makeStackFixture, tempDir, write, type StackFixture } from "./helpers";
import { makeEnvironment, startServer, thread, type World } from "./server-harness.test";

type Server = Awaited<ReturnType<typeof startServer>>;

function world(fx: StackFixture): World {
  const w: World = { environments: new Map(), threads: new Map(), running: new Set() };
  w.environments.set("env_main", makeEnvironment("env_main", fx.root));
  w.environments.set("env_ui", makeEnvironment("env_ui", fx.uiWorktree));
  w.threads.set("thr_main", thread("thr_main", "env_main"));
  w.threads.set("thr_ui", thread("thr_ui", "env_ui"));
  return w;
}

async function preview(server: Server, request: unknown, environmentId = "env_main") {
  return server.call<OperationPreview>("previewOperation", { environmentId, request });
}

async function run(server: Server, request: unknown, environmentId = "env_main") {
  const p = await preview(server, request, environmentId);
  const result = await server.call<OperationResult>("runOperation", { environmentId, request, token: p.token });
  return { preview: p, result };
}

describe.skipIf(!hasGt)("server with real gt", () => {
  let fx: StackFixture;
  let w: World;
  let server: Server;

  beforeAll(async () => {
    fx = makeStackFixture();
    w = world(fx);
    server = await startServer(w);
  });
  afterAll(() => server.dispose());

  it("returns no-environment for an unknown environment", async () => {
    const view = await server.call<StackView>("stack", { environmentId: "env_missing" });
    expect(view.status).toBe("no-environment");
  });

  it("builds the stack view from gt topology without PRs or a remote", async () => {
    const view = await server.call<StackView>("stack", { environmentId: "env_main" });
    expect(view.status).toBe("ready");
    expect(view.currentBranch).toBe("feature/api");
    expect(view.currentTracked).toBe(true);
    expect(view.remote).toBeNull();
    const byName = Object.fromEntries(view.layers.map((layer) => [layer.name, layer]));
    expect(byName["feature/model"]?.children).toEqual(["feature/api", "feature/ui"]);
    expect(byName["feature/ui"]).toMatchObject({ environmentId: "env_ui", worktreePath: fx.uiWorktree });
    expect(byName["feature/ui"]?.candidates.map((candidate) => candidate.id)).toEqual(["thr_ui"]);
    const prs = await server.call("prs", { environmentId: "env_main", refresh: true });
    expect(prs).toMatchObject({ status: "no-remote", prs: {} });
  });

  it("lists parent-relative layer files and validates refs", async () => {
    const files = await server.call("layerFiles", { environmentId: "env_main", branch: "feature/api" });
    expect(files.files.map((file: { path: string }) => file.path)).not.toContain("src/order.ts");
    expect(files.snapshot.parent).toBe("feature/model");
    await expect(server.call("layerFiles", { environmentId: "env_main", branch: "main" })).rejects.toThrow(/trunk/u);
    await expect(server.call("layerFiles", { environmentId: "env_main", branch: "nope" })).rejects.toThrow(/not tracked/u);
    await expect(server.call("layerFiles", { environmentId: "env_main", branch: "-rf" })).rejects.toThrow();
  });

  it("applies the patch byte limit setting", async () => {
    await server.harness.behavior.setSettings({ patchLimitKb: 16 });
    const files = await server.call("layerFiles", { environmentId: "env_main", branch: "feature/api" });
    const { baseSha, headSha } = files.snapshot;
    const patch = await server.call("filePatch", { environmentId: "env_main", baseSha, headSha, path: "big.txt", oldPath: null });
    expect(patch.truncated).toBe(true);
    expect(patch.patch.length).toBeLessThanOrEqual(16 * 1024);
    await server.harness.behavior.setSettings({ patchLimitKb: 1024 });
  });

  it("stores viewed state per file revision", async () => {
    const result = await server.call("setViewed", { environmentId: "env_main", branch: "feature/api", path: "src/checkout.ts", fileKey: "a:b", viewed: true });
    expect(result.viewed).toEqual([{ path: "src/checkout.ts", fileKey: "a:b" }]);
    const files = await server.call("layerFiles", { environmentId: "env_main", branch: "feature/api" });
    expect(files.viewed).toEqual([{ path: "src/checkout.ts", fileKey: "a:b" }]);
  });

  it("links a primary thread only after identity checks", async () => {
    w.threads.set("thr_other_project", thread("thr_other_project", "env_main", { projectId: "proj_2" }));
    w.threads.set("thr_archived", thread("thr_archived", "env_main", { archivedAt: 5 }));
    const otherRepo = tempDir("gs-other-");
    git(otherRepo, "init", "-q", "-b", "main");
    w.environments.set("env_other", makeEnvironment("env_other", otherRepo));
    w.threads.set("thr_other_repo", thread("thr_other_repo", "env_other"));
    await expect(server.call("linkThread", { environmentId: "env_main", branch: "feature/api", threadId: "thr_other_project" })).rejects.toThrow(/another project/u);
    await expect(server.call("linkThread", { environmentId: "env_main", branch: "feature/api", threadId: "thr_archived" })).rejects.toThrow(/archived/u);
    await expect(server.call("linkThread", { environmentId: "env_main", branch: "feature/api", threadId: "thr_other_repo" })).rejects.toThrow(/another repository/u);
    await expect(server.call("linkThread", { environmentId: "env_main", branch: "feature/api", threadId: "thr_missing" })).rejects.toThrow(/not found/u);
    const link = await server.call("linkThread", { environmentId: "env_main", branch: "feature/ui", threadId: "thr_ui" });
    expect(link).toMatchObject({ status: "valid", threadId: "thr_ui", environmentId: "env_ui" });
    let view = await server.call<StackView>("stack", { environmentId: "env_ui" });
    expect(view.layers.find((layer) => layer.name === "feature/ui")?.link?.status).toBe("valid");
    w.threads.set("thr_ui", { ...w.threads.get("thr_ui")!, archivedAt: 9 });
    view = await server.call<StackView>("stack", { environmentId: "env_main" });
    expect(view.layers.find((layer) => layer.name === "feature/ui")?.link?.status).toBe("thread-archived");
    w.threads.set("thr_ui", { ...w.threads.get("thr_ui")!, archivedAt: null });
  });

  it("sends selected local drafts once and keeps an uncertain result blocked", async () => {
    await server.call("linkThread", { environmentId: "env_main", branch: "feature/api", threadId: "thr_main" });
    const files = await server.call("layerFiles", { environmentId: "env_main", branch: "feature/api" });
    const anchor = { path: "src/checkout.ts", side: "new", startLine: 1, endLine: 1, baseSha: files.snapshot.baseSha, headSha: files.snapshot.headSha };
    const one = await server.call("noteCreate", { environmentId: "env_main", branch: "feature/api", anchor, body: "First draft", threadId: null });
    const two = await server.call("noteCreate", { environmentId: "env_main", branch: "feature/api", anchor, body: "Second draft", threadId: null });
    const messages: unknown[] = [];
    w.send = async (input) => { messages.push(input); return { ok: true, delivery: "sent" }; };
    const result = await server.call("notesSend", { environmentId: "env_main", branch: "feature/api", threadId: "thr_main", noteIds: [one.id, two.id] });
    expect(result.status).toBe("sent");
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("First draft");
    expect(JSON.stringify(messages[0])).toContain("Second draft");
    const list = await server.call("notesList", { environmentId: "env_main", branch: "feature/api" });
    expect(list.notes.filter((note: { delivery: unknown }) => note.delivery).map((note: { delivery: { status: string } }) => note.delivery.status)).toEqual(["sent", "sent"]);
    await expect(server.call("notesSend", { environmentId: "env_main", branch: "feature/api", threadId: "thr_main", noteIds: [one.id] })).rejects.toThrow(/local drafts/u);
    await expect(server.call("noteDelete", { environmentId: "env_main", noteId: one.id })).rejects.toThrow(/hidden/u);
    const three = await server.call("noteCreate", { environmentId: "env_main", branch: "feature/api", anchor, body: "Uncertain", threadId: null });
    w.send = async () => { throw new Error("connection lost"); };
    expect(await server.call("notesSend", { environmentId: "env_main", branch: "feature/api", threadId: "thr_main", noteIds: [three.id] })).toMatchObject({ status: "unknown" });
    await expect(server.call("notesSend", { environmentId: "env_main", branch: "feature/api", threadId: "thr_main", noteIds: [three.id] })).rejects.toThrow(/local drafts/u);
    // Keep the later fixture independent of this review.
    await server.call("noteHide", { environmentId: "env_main", noteId: one.id, hidden: true });
    await server.call("noteHide", { environmentId: "env_main", noteId: two.id, hidden: true });
    await server.call("noteHide", { environmentId: "env_main", noteId: three.id, hidden: true });
  });

  it("keeps private notes with replies, resolution, and outdated anchors", async () => {
    const files = await server.call("layerFiles", { environmentId: "env_main", branch: "feature/api" });
    const anchor = { path: "src/checkout.ts", side: "new", startLine: 1, endLine: 2, baseSha: files.snapshot.baseSha, headSha: files.snapshot.headSha };
    const note = await server.call("noteCreate", { environmentId: "env_main", branch: "feature/api", anchor, body: "Private: check totals", threadId: null });
    expect(note).toMatchObject({ anchorState: "current", lineText: "export function checkout() {\n  return 1;", resolved: false });
    await server.call("noteReply", { environmentId: "env_main", noteId: note.id, body: "Reply" });
    await server.call("noteSetResolved", { environmentId: "env_main", noteId: note.id, resolved: true });
    let list = await server.call("notesList", { environmentId: "env_main", branch: "feature/api" });
    expect(list.notes.find((item: { id: string }) => item.id === note.id)).toMatchObject({ resolved: true, anchorState: "current", replies: [{ body: "Reply" }] });
    expect(list.truncated).toBe(false);

    // Stale snapshot is rejected.
    await expect(
      server.call("noteCreate", { environmentId: "env_main", branch: "feature/api", anchor: { ...anchor, headSha: files.snapshot.baseSha }, body: "x", threadId: null }),
    ).rejects.toThrow(/stale/u);
    // A line outside the file is rejected.
    await expect(
      server.call("noteCreate", { environmentId: "env_main", branch: "feature/api", anchor: { ...anchor, startLine: 90, endLine: 91 }, body: "x", threadId: null }),
    ).rejects.toThrow();

    // Change line 2 only: the range note becomes outdated and keeps its original anchor.
    write(fx.root, "src/checkout.ts", "export function checkout() {\n  return 2;\n}\n");
    git(fx.root, "commit", "-qam", "api: change total");
    list = await server.call("notesList", { environmentId: "env_main", branch: "feature/api" });
    expect(list.notes.find((item: { id: string }) => item.id === note.id)).toMatchObject({ anchorState: "outdated", headSha: files.snapshot.headSha, startLine: 1, endLine: 2 });
    await server.call("noteDelete", { environmentId: "env_main", noteId: note.id });
    list = await server.call("notesList", { environmentId: "env_main", branch: "feature/api" });
    expect(list.notes.find((item: { id: string }) => item.id === note.id)).toBeUndefined();
  });

  it("disables PR actions without a remote but keeps local notes", async () => {
    const threads = await server.call("prThreads", { environmentId: "env_main", branch: "feature/api" });
    expect(threads).toMatchObject({ status: "no-remote", pr: null, threads: [] });
    const files = await server.call("layerFiles", { environmentId: "env_main", branch: "feature/api" });
    const anchor = { path: "src/checkout.ts", side: "new", startLine: 1, endLine: 1, baseSha: files.snapshot.baseSha, headSha: files.snapshot.headSha };
    await expect(server.call("pendingAdd", { environmentId: "env_main", branch: "feature/api", anchor, body: "x" })).rejects.toThrow(/remote/iu);
    await expect(server.call("submitReview", { environmentId: "env_main", branch: "feature/api", event: "APPROVE" })).resolves.toMatchObject({ outcome: "blocked" });
  });

  it("persists small drafts", async () => {
    await server.call("draftSet", { key: "note:feature/api:src/checkout.ts:new:1", value: "half-written" });
    expect(await server.call("draftGet", { key: "note:feature/api:src/checkout.ts:new:1" })).toEqual({ value: "half-written" });
    await server.call("draftSet", { key: "note:feature/api:src/checkout.ts:new:1", value: null });
    expect(await server.call("draftGet", { key: "note:feature/api:src/checkout.ts:new:1" })).toEqual({ value: null });
  });

  describe("mutations", () => {
    it("rejects a run without a matching preview token", async () => {
      const request = { kind: "restack", branch: "feature/api", scope: "only" };
      const result = await server.call<OperationResult>("runOperation", { environmentId: "env_main", request, token: "bogus" });
      expect(result.outcome).toBe("rejected");
      const p = await preview(server, request);
      const other = await server.call<OperationResult>("runOperation", { environmentId: "env_main", request: { ...request, scope: "stack" }, token: p.token });
      expect(other.outcome).toBe("rejected");
      // Tokens are single use.
      const again = await server.call<OperationResult>("runOperation", { environmentId: "env_main", request, token: p.token });
      expect(again.outcome).toBe("rejected");
    });

    it("restacks a stack across worktrees in parent-to-child order", async () => {
      write(fx.root, "README.md", "# demo\nmain moved\n");
      git(fx.root, "stash", "-q", "--include-untracked");
      git(fx.root, "checkout", "-q", "main");
      git(fx.root, "stash", "pop", "-q");
      git(fx.root, "commit", "-qam", "main: move");
      git(fx.root, "checkout", "-q", "feature/api");
      const before = await server.call<StackView>("stack", { environmentId: "env_main" });
      expect(before.layers.find((layer) => layer.name === "feature/model")?.needsRestack).toBe(true);

      // The stack of feature/api excludes its sibling feature/ui.
      const narrow = await preview(server, { kind: "restack", branch: "feature/api", scope: "stack" });
      expect(narrow.steps.map((step) => step.branch)).toEqual(["feature/model", "feature/api"]);
      const { preview: p, result } = await run(server, { kind: "restack", branch: "feature/model", scope: "upstack" });
      expect(p.allowed).toBe(true);
      expect(p.steps.map((step) => [step.branch, step.worktreePath])).toEqual([
        ["feature/model", fx.root],
        ["feature/api", fx.root],
        ["feature/ui", fx.uiWorktree],
      ]);
      expect(result.outcome).toBe("success");
      expect(result.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
      const after = await server.call<StackView>("stack", { environmentId: "env_main" });
      expect(after.layers.filter((layer) => layer.needsRestack)).toEqual([]);
      const last = await server.call("lastOperation", { environmentId: "env_main" });
      expect(last.result.id).toBe(result.id);
    }, 300_000);

    it("blocks dirty worktrees and active agents, before and at run time", async () => {
      write(fx.uiWorktree, "src/ui.tsx", "dirty\n");
      let p = await preview(server, { kind: "restack", branch: "feature/ui", scope: "only" });
      expect(p.allowed).toBe(false);
      expect(p.blockers.join(" ")).toMatch(/uncommitted changes/u);
      git(fx.uiWorktree, "checkout", "-q", "--", "src/ui.tsx");

      p = await preview(server, { kind: "restack", branch: "feature/ui", scope: "only" });
      expect(p.allowed).toBe(true);
      w.running.add("thr_ui");
      const result = await server.call<OperationResult>("runOperation", { environmentId: "env_main", request: { kind: "restack", branch: "feature/ui", scope: "only" }, token: p.token });
      expect(result.outcome).toBe("rejected");
      expect(result.summary).toMatch(/agent is active/u);
      w.running.delete("thr_ui");
    });

    it("rejects a run when a branch moved after the preview", async () => {
      const request = { kind: "restack", branch: "feature/api", scope: "only" };
      const p = await preview(server, request);
      write(fx.root, "src/extra.ts", "x\n");
      git(fx.root, "add", "-A");
      git(fx.root, "commit", "-qm", "api: extra");
      const result = await server.call<OperationResult>("runOperation", { environmentId: "env_main", request, token: p.token });
      expect(result.outcome).toBe("rejected");
      expect(result.summary).toMatch(/changed after the preview/u);
    });

    it("creates and tracks branches through gt only", async () => {
      write(fx.root, "src/new-layer.ts", "export const layer = 1;\n");
      git(fx.root, "add", "src/new-layer.ts");
      const created = await run(server, { kind: "create", name: "feature/new-layer", message: "new layer", stageAll: false });
      expect(created.result.outcome).toBe("success");
      let view = await server.call<StackView>("stack", { environmentId: "env_main" });
      expect(view.layers.find((layer) => layer.name === "feature/new-layer")?.parent).toBe("feature/api");
      const exists = await preview(server, { kind: "create", name: "feature/api", message: "x", stageAll: false });
      expect(exists.blockers.join(" ")).toMatch(/already exists/u);

      const tracked = await run(server, { kind: "track", branch: "plain", parent: "main" });
      expect(tracked.result.outcome).toBe("success");
      view = await server.call<StackView>("stack", { environmentId: "env_main" });
      expect(view.layers.find((layer) => layer.name === "plain")?.parent).toBe("main");
      git(fx.root, "checkout", "-q", "feature/api");
    });

    it("stops at a conflict and aborts only the real current operation", async () => {
      const noop = await preview(server, { kind: "recover", worktreePath: fx.root, action: "abort" });
      expect(noop.blockers.join(" ")).toMatch(/No rebase is in progress/u);
      const outside = await preview(server, { kind: "recover", worktreePath: tempDir("gs-x-"), action: "abort" });
      expect(outside.blockers.join(" ")).toMatch(/not a worktree/u);

      git(fx.root, "checkout", "-q", "main");
      write(fx.root, "src/order.ts", "export type Order = { conflicting: true };\n");
      git(fx.root, "add", "-A");
      git(fx.root, "commit", "-qm", "main: conflicting order");
      git(fx.root, "checkout", "-q", "feature/api");
      const { result } = await run(server, { kind: "restack", branch: "feature/model", scope: "upstack" });
      expect(result.outcome).toBe("conflict");
      expect(result.steps[0]).toMatchObject({ branch: "feature/model", status: "conflict" });
      expect(result.steps.slice(1).every((step) => step.status === "pending")).toBe(true);

      const blocked = await preview(server, { kind: "sync" });
      expect(blocked.blockers.join(" ")).toMatch(/rebase in progress/u);
      const cont = await preview(server, { kind: "recover", worktreePath: fx.root, action: "continue" });
      expect(cont.blockers.join(" ")).toMatch(/conflicted/u);
      const aborted = await run(server, { kind: "recover", worktreePath: fx.root, action: "abort" });
      expect(aborted.result.outcome).toBe("success");
      expect(existsSync(path.join(fx.root, ".git", "rebase-merge"))).toBe(false);
      expect(git(fx.root, "branch", "--show-current")).toBe("feature/api");
    });

    it("refuses sync and submit without a remote", async () => {
      const sync = await preview(server, { kind: "sync" });
      expect(sync.blockers.join(" ")).toMatch(/no Git remote/u);
      const submit = await preview(server, { kind: "submit", branch: "feature/api", stack: false });
      expect(submit.blockers.join(" ")).toMatch(/no GitHub remote/u);
    });
  });
});

describe.skipIf(!hasGt)("uninitialized repository", () => {
  it("shows the uninitialized state and initializes only on explicit action", async () => {
    const root = tempDir("gs-init-");
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "-q", "--allow-empty", "-m", "init");
    const w: World = { environments: new Map([["env_i", makeEnvironment("env_i", root)]]), threads: new Map(), running: new Set() };
    const server = await startServer(w);
    try {
      const view = await server.call<StackView>("stack", { environmentId: "env_i" });
      expect(view.status).toBe("gt-uninitialized");
      expect(existsSync(path.join(root, ".git", ".graphite_repo_config"))).toBe(false);
      const missing = await preview(server, { kind: "init", trunk: "develop" }, "env_i");
      expect(missing.blockers.join(" ")).toMatch(/does not exist/u);
      const { result } = await run(server, { kind: "init", trunk: "main" }, "env_i");
      expect(result.outcome).toBe("success");
      expect(JSON.parse(readFileSync(path.join(root, ".git", ".graphite_repo_config"), "utf8")).trunk).toBe("main");
      expect((await server.call<StackView>("stack", { environmentId: "env_i" })).status).toBe("ready");
    } finally {
      await server.dispose();
    }
  });
});

describe("non-git environment", () => {
  it("reports no-repo", async () => {
    const dir = tempDir("gs-nogit-");
    const w: World = { environments: new Map([["env_n", makeEnvironment("env_n", dir)]]), threads: new Map(), running: new Set() };
    const server = await startServer(w);
    try {
      const view = await server.call<StackView>("stack", { environmentId: "env_n" });
      expect(view.status).toBe("no-repo");
    } finally {
      await server.dispose();
    }
  });
});

// Silence unused import lint for gt in environments without it.
void gt;
