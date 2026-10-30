// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract";
import type { LayerView, OperationPreview, StackView } from "./contract";
import type { ChangedFile, DiffSnapshot } from "./lib/model";
import { ThreadGraphiteTab, ProjectStacksPage } from "./app";

type Contract = typeof rpcContract;
type Handlers = PluginRpcTestHandlers<Contract>;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const SHA = (digit: string) => digit.repeat(40);
const ENV = "env_fixture";

function layer(name: string, parent: string | null, children: string[], extra: Partial<LayerView> = {}): LayerView {
  return {
    name,
    trunk: parent === null,
    parent,
    parentRecordedSha: null,
    needsRestack: false,
    headSha: SHA(String((name.length % 9) + 1)),
    commits: parent ? [{ sha: SHA("c"), subject: `Commit on ${name}`, author: "dev", time: 1_700_000_000 }] : [],
    commitCount: parent ? 1 : 0,
    commitsTruncated: false,
    children,
    worktreePath: null,
    environmentId: null,
    link: null,
    candidates: [],
    ...extra,
  };
}

function stackView(overrides: Partial<StackView> = {}): StackView {
  return {
    status: "ready",
    message: null,
    environmentId: ENV,
    projectId: "proj_1",
    hostId: "host_1",
    repoKey: "repo_1",
    repoRoot: "/tmp/graphite-stack-live-check",
    currentBranch: "feature/checkout-api",
    currentTracked: true,
    gtVersion: "1.8.6",
    gtTested: true,
    ghAvailable: false,
    trunks: ["main"],
    layers: [
      layer("main", null, ["feature/order-model"]),
      layer("feature/order-model", "main", ["feature/checkout-api", "feature/checkout-ui"]),
      layer("feature/checkout-api", "feature/order-model", [], {
        candidates: [{ id: "thr_candidate", title: "Build API", status: "idle", environmentId: ENV, archived: false }],
      }),
      layer("feature/checkout-ui", "feature/order-model", []),
    ],
    worktrees: [],
    localBranches: ["main", "feature/order-model", "feature/checkout-api", "feature/checkout-ui"],
    remote: null,
    remoteName: null,
    busyRepo: false,
    fetchedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function snapshotFor(branch: string, parent: string): DiffSnapshot {
  return { branch, parent, headSha: SHA("b"), parentSha: SHA("a"), baseSha: SHA("a"), diverged: false };
}

function changed(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    oldPath: null,
    status: "M",
    similarity: null,
    additions: 3,
    deletions: 1,
    binary: false,
    oldBlob: SHA("1"),
    newBlob: SHA("2"),
    oldMode: "100644",
    newMode: "100644",
    ...extra,
  };
}

const PATCH = "diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,3 +1,5 @@\n a\n+b\n+c\n d\n e\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Every rpc method fails unless a test supplies it, so stray calls show up. */
function handlers(overrides: Partial<Handlers> = {}): Handlers {
  const fail = (method: string) => () => {
    throw new Error(`unexpected rpc ${method}`);
  };
  const defaults: Partial<Handlers> = {
    stack: () => stackView(),
    prs: () => ({ status: "no-remote", message: null, fetchedAt: null, stale: false, prs: {} }),
    lastOperation: () => ({ result: null }),
    layerFiles: ({ branch }) => ({
      snapshot: snapshotFor(branch, branch === "feature/order-model" ? "main" : "feature/order-model"),
      files: [changed(`src/${branch.split("/")[1]}.ts`), changed("src/api.ts")],
      truncated: false,
      error: null,
      viewed: [],
    }),
    notesList: () => ({ notes: [], snapshot: null, truncated: false }),
    filePatch: () => ({ patch: PATCH, bytes: PATCH.length, truncated: false, binary: false }),
    prThreads: () => ({ status: "no-remote", message: null, pr: null, viewer: null, threads: [], truncated: false, pending: null }),
    draftGet: () => ({ value: null }),
    draftSet: () => ({ ok: true }),
  };
  const all = { ...defaults, ...overrides } as Partial<Handlers>;
  const result = {} as Record<string, unknown>;
  for (const method of Object.keys(rpcContract)) {
    result[method] = all[method as keyof Handlers] ?? fail(method);
  }
  return result as Handlers;
}

function renderTab(options: RenderSlotOptions<Contract> & { props?: Partial<ExperimentalThreadTabProps> } = {}) {
  const { props, ...rest } = options;
  return renderSlot<ExperimentalThreadTabProps, Contract>(
    { component: ThreadGraphiteTab },
    { threadId: "thr_self", environment: { id: ENV }, ...props } as ExperimentalThreadTabProps,
    { rpc: handlers(), context: { projectId: "proj_1", threadId: "thr_self" }, ...rest },
  );
}

const calls = (slot: ReturnType<typeof renderTab>, method: string) =>
  slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input as Record<string, unknown>);

describe("registration", () => {
  it("registers a fixed thread tab and a project nav panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.tabs.map((tab) => [tab.id, tab.availability, tab.context.kind])).toEqual([["graphite", "fixed", "thread"]]);
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["stacks"]);
  });
});

describe("thread tab states", () => {
  it("explains a thread without an environment and makes no reads", async () => {
    const slot = renderTab({ props: { environment: null } });
    await slot.findByText("No environment");
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("shows the missing Graphite CLI state with setup and retry", async () => {
    const slot = renderTab({ rpc: handlers({ stack: () => stackView({ status: "no-gt", layers: [], trunks: [] }) }) });
    await slot.findByText("Graphite CLI unavailable");
    expect(slot.getByRole("link", { name: "Install instructions" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls(slot, "stack").length).toBe(2));
  });

  it("does not mistake the untracked-only branch list for all local refs", async () => {
    const slot = renderTab({ rpc: handlers({ stack: () => stackView({ localBranches: ["untracked-only"] }) }) });
    await slot.findByRole("list", { name: "Graphite stack" });
    expect(slot.queryByText("Incomplete Graphite stack")).toBeNull();
    expect(slot.queryByText("Parent ref missing")).toBeNull();
  });

  it("shows an incomplete stack without hiding its branches", async () => {
    const view = stackView();
    view.layers.find((item) => item.name === "feature/order-model")!.parent = "09-12-fix_workflow_message_409";
    const slot = renderTab({ rpc: handlers({ stack: () => view }) });
    await slot.findByText("Incomplete Graphite stack");
    expect(slot.getByText("Parent not tracked")).toBeTruthy();
    const details = slot.getByText("Show parent details").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(slot.getByText("Show parent details"));
    expect(slot.getByText("feature/order-model → 09-12-fix_workflow_message_409")).toBeTruthy();
    const rail = slot.getByRole("list", { name: "Graphite stack" });
    expect(within(rail).getAllByRole("button").length).toBe(2);
    fireEvent.click(slot.getByRole("button", { name: /^All/u }));
    await waitFor(() => expect(within(rail).getAllByRole("button").length).toBe(4));
    expect(slot.queryByText("Unsupported Graphite output")).toBeNull();
  });

  it("does not read while the tab is hidden", async () => {
    const slot = renderTab({ tabVisible: false });
    await new Promise((done) => setTimeout(done, 30));
    expect(calls(slot, "stack")).toEqual([]);
  });
});

describe("stack review", () => {
  it("shows the Graphite topology and the current layer's parent-relative diff", async () => {
    const slot = renderTab();
    const rail = await slot.findByRole("list", { name: "Graphite stack" });
    const names = within(rail)
      .getAllByRole("button")
      .map((button) => button.getAttribute("data-layer"));
    expect(names).toEqual(["feature/checkout-api", "feature/order-model", "main"]);
    fireEvent.click(slot.getByRole("button", { name: /^All/u }));
    await waitFor(() =>
      expect(
        within(rail)
          .getAllByRole("button")
          .map((button) => button.getAttribute("data-layer")),
      ).toEqual(["feature/checkout-ui", "feature/checkout-api", "feature/order-model", "main"]),
    );
    await waitFor(() => expect(calls(slot, "layerFiles")).toEqual([{ environmentId: ENV, branch: "feature/checkout-api" }]));
    const diff = await slot.findByLabelText("Inline comment diff");
    expect(diff.textContent).toContain("+b");
    expect(diff.textContent).not.toContain("diff --git");
    expect(diff.textContent).not.toContain("--- a/");
    expect(calls(slot, "filePatch")[0]).toMatchObject({ baseSha: SHA("a"), headSha: SHA("b"), path: "src/checkout-api.ts" });
    // Local stacks without a remote still work, and PR writes say why they are off.
    expect(slot.getByText(/no remote/u)).toBeTruthy();
  });

  it("paints topology first and requests only visible details until All is clicked", async () => {
    const full = stackView();
    full.layers.find((item) => item.name === "main")!.children.push("feature/other");
    full.layers.push(layer("feature/other", "main", []));
    const pending = deferred<StackView>();
    const slot = renderTab({ rpc: handlers({ stack: ({ detailBranches }) => {
      if (detailBranches?.length) return pending.promise;
      return { ...full, layers: full.layers.map((item) => ({ ...item, commits: [], commitCount: 0, detailsLoaded: false })) };
    } }) });
    const rail = await slot.findByRole("list", { name: "Graphite stack" });
    expect(within(rail).getAllByText("Loading commits…").length).toBeGreaterThan(0);
    await waitFor(() => expect(calls(slot, "stack").length).toBeGreaterThan(1));
    expect(calls(slot, "stack")[0]?.detailBranches).toEqual([]);
    expect(calls(slot, "stack")[1]?.detailBranches).toEqual(["main", "feature/order-model", "feature/checkout-api"]);
    await act(async () => pending.resolve({ ...full, layers: full.layers.map((item) => ({ ...item, detailsLoaded: true })) }));
    await waitFor(() => expect(within(rail).getByText("Commit on feature/checkout-api")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: /^All/u }));
    await waitFor(() => expect(calls(slot, "stack").some((call) => (call.detailBranches as string[])?.includes("feature/other"))).toBe(true));
  });

  it("scopes the rail to the current stack and follows a pick from All", async () => {
    const view = stackView();
    view.layers.find((item) => item.name === "main")!.children.push("feature/other-base");
    view.layers.push(layer("feature/other-base", "main", ["feature/other-top"]), layer("feature/other-top", "feature/other-base", []));
    const slot = renderTab({ rpc: handlers({ stack: () => view }) });
    const rail = await slot.findByRole("list", { name: "Graphite stack" });
    expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("data-layer"))).toEqual([
      "feature/checkout-api",
      "feature/order-model",
      "main",
    ]);
    expect(slot.getByRole("button", { name: "This stack · 3" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /^All/u }));
    expect(within(rail).getAllByRole("button").length).toBe(6);
    fireEvent.click(within(rail).getByRole("button", { name: /feature\/other-top/u }));
    await waitFor(() =>
      expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("data-layer"))).toEqual([
        "feature/other-top",
        "feature/other-base",
        "main",
      ]),
    );
    expect(slot.getByRole("button", { name: "This stack · 3" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("bb-graphite-stack:scope:repo_1") ?? "{}")).toMatchObject({
      scope: "stack",
      anchor: "feature/other-top",
    });
  });

  it("hides repo-wide parent warnings outside the scoped stack", async () => {
    const view = stackView();
    view.layers.find((item) => item.name === "main")!.children.push("feature/other-base");
    view.layers.push(layer("feature/other-base", "gone", ["feature/other-top"]), layer("feature/other-top", "feature/other-base", []));
    const slot = renderTab({ rpc: handlers({ stack: () => view }) });
    await slot.findByRole("list", { name: "Graphite stack" });
    expect(slot.queryByText("Incomplete Graphite stack")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^All/u }));
    await slot.findByText("Incomplete Graphite stack");
  });

  it("restores the saved stack for a repository", async () => {
    window.localStorage.setItem("bb-graphite-stack:scope:repo_1", JSON.stringify({ scope: "stack", anchor: "feature/checkout-ui" }));
    const slot = renderTab();
    const rail = await slot.findByRole("list", { name: "Graphite stack" });
    await waitFor(() => expect(calls(slot, "layerFiles").map((input) => input.branch)).toContain("feature/checkout-ui"));
    expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("data-layer"))).toEqual([
      "feature/checkout-ui",
      "feature/order-model",
      "main",
    ]);
  });

  it("previews a layer on selection without any mutation", async () => {
    const slot = renderTab();
    const row = await slot.findByRole("button", { name: /feature\/order-model/u });
    fireEvent.click(row);
    await waitFor(() => expect(calls(slot, "layerFiles").map((input) => input.branch)).toContain("feature/order-model"));
    expect(calls(slot, "runOperation")).toEqual([]);
    expect(calls(slot, "previewOperation")).toEqual([]);
  });

  it("ignores an older layer response that arrives after a newer one", async () => {
    const slow = deferred<Awaited<ReturnType<Handlers["layerFiles"]>>>();
    const slot = renderTab({
      rpc: handlers({
        layerFiles: ({ branch }) =>
          branch === "feature/checkout-api"
            ? slow.promise
            : { snapshot: snapshotFor(branch, "feature/order-model"), files: [changed("src/ui.tsx")], truncated: false, error: null, viewed: [] },
      }),
    });
    fireEvent.click(await slot.findByRole("button", { name: /^All/u }));
    await waitFor(() => expect(slot.getByRole("button", { name: /feature\/checkout-ui/u })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: /feature\/checkout-ui/u }));
    await slot.findByText("ui.tsx");
    await act(async () => {
      slow.resolve({ snapshot: snapshotFor("feature/checkout-api", "x"), files: [changed("src/stale.ts")], truncated: false, error: null, viewed: [] });
      await Promise.resolve();
    });
    expect(slot.queryByText("stale.ts")).toBeNull();
  });

  it("reloads after a GRAPHITE_CHANGED signal for this repository only", async () => {
    const slot = renderTab();
    await slot.findByRole("list", { name: "Graphite stack" });
    await slot.behavior.emitRealtime("graphite-changed", { repoKey: "other_repo" });
    await new Promise((done) => setTimeout(done, 300));
    expect(calls(slot, "stack").length).toBe(1);
    await slot.behavior.emitRealtime("graphite-changed", { repoKey: "repo_1" });
    await waitFor(() => expect(calls(slot, "stack").length).toBe(2));
  });

  it("collapses a burst of signals and throttles realtime reloads", async () => {
    const slot = renderTab();
    await slot.findByRole("list", { name: "Graphite stack" });
    for (let index = 0; index < 10; index += 1) await slot.behavior.emitRealtime("graphite-changed", { repoKey: "repo_1" });
    await waitFor(() => expect(calls(slot, "stack").length).toBe(2));
    // A signal right after a reload waits for the minimum interval.
    await slot.behavior.emitRealtime("graphite-changed", { repoKey: "repo_1" });
    await new Promise((done) => setTimeout(done, 600));
    expect(calls(slot, "stack").length).toBe(2);
    await waitFor(() => expect(calls(slot, "stack").length).toBe(3), { timeout: 3000 });
  });

  it("links a candidate thread and opens a thread without a fake composer", async () => {
    const slot = renderTab();
    await slot.findByText("Build API");
    fireEvent.click(slot.getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(calls(slot, "linkThread")).toEqual([{ environmentId: ENV, branch: "feature/checkout-api", threadId: "thr_candidate" }]),
    );
    fireEvent.click(slot.getByRole("button", { name: /New thread/u }));
    const compose = slot.inspection.navigateCalls.find((call) => call.method === "toCompose");
    expect(compose).toBeTruthy();
    expect(JSON.stringify(compose)).toContain("feature/checkout-api");
  });
});

describe("line comments", () => {
  async function openComposer(slot: ReturnType<typeof renderTab>) {
    await slot.findByLabelText("Inline comment diff");
    fireEvent.click(slot.getByRole("button", { name: "Add comment on new line 2" }));
    fireEvent.click(slot.getByText("Line range and destination"));
    const body = await slot.findByRole("textbox", { name: "Comment" });
    await waitFor(() => expect(body.hasAttribute("readonly")).toBe(false));
    return body;
  }

  it("previews selected local drafts before sending one thread message", async () => {
    const view = stackView();
    view.layers.find((item) => item.name === "feature/checkout-api")!.link = { branch: "feature/checkout-api", threadId: "thr_self", environmentId: ENV, linkedAt: 1, status: "valid", thread: null };
    const anchor = { path: "src/checkout-api.ts", side: "new" as const, startLine: 2, endLine: 2, baseSha: SHA("a"), headSha: SHA("b") };
    const note = noteFrom({ environmentId: ENV, branch: "feature/checkout-api", anchor, body: "Please check this", threadId: "thr_self" });
    const slot = renderTab({ rpc: handlers({ stack: () => view, notesList: () => ({ notes: [note], snapshot: snapshotFor("feature/checkout-api", "feature/order-model"), truncated: false }), notesSend: () => ({ status: "sent", message: null }) }) });
    fireEvent.click(await slot.findByRole("tab", { name: /Comments/u }));
    fireEvent.click(await slot.findByRole("checkbox", { name: /Please check this/u }));
    fireEvent.click(slot.getByRole("button", { name: "Review message · 1" }));
    expect(slot.getByText("Message to linked thread")).toBeTruthy();
    expect(calls(slot, "notesSend")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Send 1 comment" }));
    await waitFor(() => expect(calls(slot, "notesSend")).toEqual([{ environmentId: ENV, branch: "feature/checkout-api", threadId: "thr_self", noteIds: ["note_1"] }]));
  });

  it("keeps full-file context in the same inline diff", async () => {
    const slot = renderTab({ rpc: handlers({ fileSides: () => ({ status: "ok", old: { path: "src/checkout-api.ts", content: "a\nd\ne\nunchanged\n" }, new: { path: "src/checkout-api.ts", content: "a\nb\nc\nd\ne\nunchanged\n" }, message: null }) }) });
    const diff = await slot.findByLabelText("Inline comment diff");
    expect(within(diff).queryByText(/unchanged/u)).toBeNull();
    expect(slot.queryByRole("button", { name: "Native diff" })).toBeNull();
    expect(slot.queryByRole("group", { name: "Diff layout" })).toBeNull();
    fireEvent.click(slot.getByRole("checkbox", { name: "Full file" }));
    await waitFor(() => expect(within(diff).getByText(/unchanged/u)).toBeTruthy());
    expect(slot.getByRole("button", { name: "Add comment on new line 6" })).toBeTruthy();
  });

  it("uses the active code theme for syntax in the inline diff", async () => {
    const slot = renderTab({
      codeTheme: { mode: "dark", name: "test-code", theme: { name: "test-code", type: "dark", fg: "#eeeeee", bg: "#181818", colors: {}, tokenColors: [{ scope: ["keyword", "storage.type", "storage.modifier"], settings: { foreground: "#ff6688" } }, { scope: "constant.numeric", settings: { foreground: "#88ccff" } }] } },
      rpc: handlers({ filePatch: () => ({ patch: "diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+const answer = 42;\n", bytes: 100, truncated: false, binary: false }) }),
    });
    const diff = await slot.findByLabelText("Inline comment diff");
    expect(diff.getAttribute("data-code-mode")).toBe("dark");
    await waitFor(() => expect(within(diff).getByText("const").getAttribute("style")).toContain("color:"));
  });

  it("opens the composer directly beneath a selected diff line", async () => {
    const slot = renderTab();
    await slot.findByLabelText("Inline comment diff");
    fireEvent.click(slot.getByRole("button", { name: "Add comment on new line 2" }));
    const form = slot.getByRole("form", { name: "New comment" });
    expect(form.closest(".gs-inline-comments")).toBeTruthy();
    expect(form.querySelector("details")?.open).toBe(false);
    fireEvent.click(slot.getByText("Line range and destination"));
    const start = await slot.findByLabelText("Start line") as HTMLInputElement;
    expect(start.value).toBe("2");
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.click(slot.getByRole("button", { name: "Add comment on new line 2" }));
    expect(slot.getByRole("form", { name: "New comment" })).toBeTruthy();
  });

  it("saves a private note anchored by SHA, path, side, and range", async () => {
    const slot = renderTab({ rpc: handlers({ noteCreate: (input) => ({ ...noteFrom(input) }) }) });
    const body = await openComposer(slot);
    fireEvent.change(slot.getByLabelText("Start line"), { target: { value: "2" } });
    fireEvent.change(slot.getByLabelText("End line"), { target: { value: "3" } });
    fireEvent.change(body, { target: { value: "Check null input" } });
    // PR comments are off without a remote, with the reason shown.
    expect((slot.getByRole("radio", { name: /Pending PR comment/u }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls(slot, "noteCreate").length).toBe(1));
    expect(calls(slot, "noteCreate")[0]).toEqual({
      environmentId: ENV,
      branch: "feature/checkout-api",
      anchor: { path: "src/checkout-api.ts", side: "new", startLine: 2, endLine: 3, baseSha: SHA("a"), headSha: SHA("b") },
      body: "Check null input",
      // No thread is linked to the branch, so the note has no thread.
      threadId: null,
    });
    expect(calls(slot, "pendingAdd")).toEqual([]);
  });

  it("deletes the draft after a quick submit and never restores it", async () => {
    const slot = renderTab({ rpc: handlers({ noteCreate: (input) => noteFrom(input) }) });
    const body = await openComposer(slot);
    fireEvent.change(slot.getByLabelText("Start line"), { target: { value: "2" } });
    fireEvent.change(body, { target: { value: "Fast" } });
    fireEvent.click(slot.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls(slot, "noteCreate").length).toBe(1));
    await new Promise((done) => setTimeout(done, 800));
    const sets = calls(slot, "draftSet");
    expect(sets.length).toBeGreaterThan(0);
    expect(sets[sets.length - 1]!.value).toBeNull();
  });

  it("saves a pending draft under its own file key after a fast file switch", async () => {
    const slot = renderTab();
    const body = await openComposer(slot);
    fireEvent.change(slot.getByLabelText("Start line"), { target: { value: "2" } });
    fireEvent.change(body, { target: { value: "Draft for file A" } });
    // Switch file before the 600 ms debounce.
    fireEvent.click(slot.getByTitle("src/api.ts"));
    await new Promise((done) => setTimeout(done, 800));
    const sets = calls(slot, "draftSet").filter((input) => input.value !== null);
    expect(sets.length).toBeGreaterThan(0);
    for (const input of sets) {
      expect(String(input.key)).toContain("src/checkout-api.ts");
      expect(String(input.value)).toContain("Draft for file A");
    }
  });

  it("keeps the editor read-only until the saved draft loads", async () => {
    const saved = deferred<{ value: string | null }>();
    const slot = renderTab({ rpc: handlers({ draftGet: () => saved.promise }) });
    await slot.findByLabelText("Inline comment diff");
    fireEvent.click(slot.getByRole("button", { name: "Add comment on new line 2" }));
    fireEvent.click(slot.getByText("Line range and destination"));
    const body = await slot.findByRole("textbox", { name: "Comment" });
    expect(body.hasAttribute("readonly")).toBe(true);
    await act(async () => {
      saved.resolve({ value: JSON.stringify({ side: "new", start: "4", end: "", destination: "private", body: "Saved text" }) });
      await Promise.resolve();
    });
    await waitFor(() => expect((body as HTMLTextAreaElement).value).toBe("Saved text"));
    expect(calls(slot, "draftSet")).toEqual([]);
  });

  it("keeps the text and does not retry after a failed save", async () => {
    const slot = renderTab({
      rpc: handlers({
        noteCreate: () => {
          throw new Error("Snapshot is stale; refresh");
        },
      }),
    });
    const body = await openComposer(slot);
    fireEvent.change(slot.getByLabelText("Start line"), { target: { value: "2" } });
    fireEvent.change(body, { target: { value: "Keep me" } });
    fireEvent.click(slot.getByRole("button", { name: "Save draft" }));
    await slot.findByText(/Snapshot is stale/u);
    expect((body as HTMLTextAreaElement).value).toBe("Keep me");
    await new Promise((done) => setTimeout(done, 50));
    expect(calls(slot, "noteCreate").length).toBe(1);
  });
});

describe("operations", () => {
  const preview = (allowed: boolean): OperationPreview => ({
    token: "tok_1",
    title: "Restack feature/checkout-api and upstack",
    allowed,
    blockers: allowed ? [] : ["feature/checkout-api has uncommitted changes in /tmp/wt"],
    warnings: ["gt skips branches checked out in other worktrees"],
    steps: [{ branch: "feature/checkout-api", worktreePath: null, environmentId: null, argv: ["gt", "restack", "--only"], status: "pending", message: null }],
    dryRunOutput: null,
  });

  it("previews affected branches, then runs with the preview token", async () => {
    const slot = renderTab({
      rpc: handlers({
        previewOperation: () => preview(true),
        runOperation: () => ({
          id: "op_1",
          outcome: "partial",
          summary: "1 of 2 branches restacked",
          steps: [
            { branch: "feature/checkout-api", worktreePath: null, environmentId: null, argv: [], status: "done", message: null },
            { branch: "feature/checkout-ui", worktreePath: "/tmp/wt", environmentId: null, argv: [], status: "blocked", message: "Agent active" },
          ],
          output: "",
          finishedAt: Date.now(),
        }),
      }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Restack…" }));
    await slot.findByText("Restack feature/checkout-api and upstack");
    expect(slot.getByText("gt skips branches checked out in other worktrees")).toBeTruthy();
    expect(calls(slot, "previewOperation")[0]).toEqual({
      environmentId: ENV,
      request: { kind: "restack", branch: "feature/checkout-api", scope: "upstack" },
    });
    expect(calls(slot, "runOperation")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Run" }));
    await slot.findByText("Partly done");
    expect(calls(slot, "runOperation")[0]).toMatchObject({ token: "tok_1" });
    expect(slot.getByText("Agent active")).toBeTruthy();
  });

  it("blocks Run when the preview has blockers", async () => {
    const slot = renderTab({ rpc: handlers({ previewOperation: () => preview(false) }) });
    fireEvent.click(await slot.findByRole("button", { name: "Restack…" }));
    await slot.findByText(/has uncommitted changes/u);
    expect((slot.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("pull request writes", () => {
  it("disables a retry after an unknown reply outcome", async () => {
    const pr = {
      number: 7,
      title: "Add checkout API",
      url: "https://github.com/acme/app/pull/7",
      graphiteUrl: "https://app.graphite.dev/github/pr/acme/app/7",
      state: "OPEN" as const,
      isDraft: false,
      reviewDecision: null,
      headRefName: "feature/checkout-api",
      headRefOid: SHA("b"),
      baseRefName: "feature/order-model",
      checks: "passing" as const,
    };
    const slot = renderTab({
      rpc: handlers({
        prs: () => ({ status: "ok", message: null, fetchedAt: Date.now(), stale: false, prs: { "feature/checkout-api": pr } }),
        prThreads: () => ({
          status: "ok",
          message: null,
          pr,
          viewer: "me",
          truncated: false,
          pending: null,
          threads: [
            {
              id: "PRRT_1",
              isResolved: false,
              isOutdated: false,
              path: "src/checkout-api.ts",
              line: 2,
              originalLine: 2,
              startLine: null,
              diffSide: "RIGHT",
              viewerCanResolve: true,
              viewerCanUnresolve: false,
              viewerCanReply: true,
              commentsTruncated: false,
              comments: [{ id: "c1", databaseId: 1, author: "mira", body: "Why?", createdAt: "2026-10-01T00:00:00Z", url: null, state: "SUBMITTED" }],
            },
          ],
        }),
        prReply: () => ({ outcome: "unknown", message: null, id: null, url: null }),
      }),
    });
    expect(await slot.findByRole("link", { name: /Open in Graphite/u })).toBeTruthy();
    expect(slot.container.textContent).not.toMatch(/#7\b/u);
    const reply = await slot.findByRole("textbox", { name: "Reply on the pull request" });
    await waitFor(() => expect(reply.hasAttribute("readonly")).toBe(false));
    fireEvent.change(reply, { target: { value: "Because" } });
    fireEvent.click(slot.getByRole("button", { name: "Post reply to GitHub" }));
    await slot.findByText(/did not confirm/u);
    expect((slot.getByRole("button", { name: "Post reply to GitHub" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(slot, "prReply").length).toBe(1);
  });
});

describe("comments without a pull request", () => {
  it("keeps private notes primary and shows no disabled review form", async () => {
    const slot = renderTab();
    fireEvent.click(await slot.findByRole("tab", { name: /Comments/u }));
    await slot.findByText("Local and thread comments");
    await waitFor(() => expect(calls(slot, "prThreads").length).toBe(1));
    const panel = slot.getByRole("tabpanel", { name: /Comments/u });
    expect(within(panel).getAllByText(/no remote/u)).toHaveLength(1);
    expect(slot.queryByRole("region", { name: "Finish review" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Submit review" })).toBeNull();
  });

  it("still shows stored pending comments, read-only, when the PR is unavailable", async () => {
    const slot = renderTab({
      rpc: handlers({
        prThreads: () => ({
          status: "no-remote",
          message: null,
          pr: null,
          viewer: null,
          threads: [],
          truncated: false,
          pending: {
            prNumber: 7,
            body: "",
            submission: null,
            lastError: null,
            comments: [
              { id: "pc1", path: "src/api.ts", side: "new", startLine: 2, endLine: 2, baseSha: SHA("a"), headSha: SHA("b"), body: "Kept draft", createdAt: 1, anchorState: "current" },
            ],
          },
        }),
      }),
    });
    fireEvent.click(await slot.findByRole("tab", { name: /Comments/u }));
    const review = await slot.findByRole("region", { name: "Finish review" });
    expect(within(review).getByText("Kept draft")).toBeTruthy();
    expect(within(review).getByText(/BB keeps these pending comments/u)).toBeTruthy();
    expect((within(review).getByRole("button", { name: "Submit review" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("project page", () => {
  it("lists project repositories and opens one", async () => {
    const slot = renderSlot<{ subPath: string }, Contract>(
      { component: ProjectStacksPage },
      { subPath: "proj_1" },
      {
        rpc: handlers({
          projectRepos: () => ({
            repos: [
              { key: "r1", label: "storefront", hostId: "h", environmentId: ENV, environmentIds: [ENV], status: "ready", message: null },
              { key: "r2", label: "docs", hostId: "h", environmentId: "env_2", environmentIds: ["env_2"], status: "no-gt", message: null },
            ],
            environmentsWithoutGit: 0,
          }),
        }),
        sdk: { projects: { list: async () => [] } },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /storefront/u }));
    expect(slot.inspection.navigateCalls.some((call) => JSON.stringify(call).includes("proj_1/r1"))).toBe(true);
  });
});

function noteFrom(input: Parameters<Handlers["noteCreate"]>[0]) {
  return {
    id: "note_1",
    repoKey: "repo_1",
    branch: input.branch,
    path: input.anchor.path,
    side: input.anchor.side,
    startLine: input.anchor.startLine,
    endLine: input.anchor.endLine,
    baseSha: input.anchor.baseSha,
    headSha: input.anchor.headSha,
    lineText: "",
    body: input.body,
    threadId: input.threadId ?? null,
    parentId: null,
    resolved: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    anchorState: "current" as const,
    replies: [],
  };
}
