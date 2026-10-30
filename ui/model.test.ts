import { describe, expect, it } from "vitest";
import type { LayerView } from "../contract";
import { GRAPHITE_CHANGED } from "../contract";
import { GRAPHITE_CHANGED_CHANNEL } from "./rpc";
import { downstack, fileKey, patchRanges, prLink, railRows, stackRows, validateRange } from "./model";

function layer(name: string, parent: string | null, children: string[]): LayerView {
  return {
    name,
    trunk: parent === null,
    parent,
    parentRecordedSha: null,
    needsRestack: false,
    headSha: "a".repeat(40),
    commits: [],
    commitCount: 0,
    commitsTruncated: false,
    children,
    worktreePath: null,
    environmentId: null,
    link: null,
    candidates: [],
  };
}

// Same topology as the live fixture: main -> order-model -> {checkout-api, checkout-ui}.
const fixture = {
  trunks: ["main"],
  layers: [
    layer("main", null, ["feature/order-model"]),
    layer("feature/order-model", "main", ["feature/checkout-api", "feature/checkout-ui"]),
    layer("feature/checkout-api", "feature/order-model", []),
    layer("feature/checkout-ui", "feature/order-model", []),
  ],
};

describe("railRows", () => {
  it("puts children above parents and the trunk last, with forks one column right", () => {
    const rows = railRows(fixture).map((row) => [row.layer.name, row.depth]);
    expect(rows).toEqual([
      ["feature/checkout-ui", 1],
      ["feature/checkout-api", 0],
      ["feature/order-model", 0],
      ["main", 0],
    ]);
  });

  it("keeps layers whose parent is not tracked", () => {
    const rows = railRows({ trunks: ["main"], layers: [layer("main", null, []), layer("orphan", "gone", [])] });
    expect(rows.map((row) => row.layer.name)).toEqual(["main", "orphan"]);
  });

  it("bounds indentation when the trunk has many children", () => {
    const children = Array.from({ length: 96 }, (_, index) => `stack-${String(index).padStart(2, "0")}`);
    const rows = railRows({
      trunks: ["main"],
      layers: [layer("main", null, children), ...children.map((name) => layer(name, "main", []))],
    });
    expect(rows).toHaveLength(97);
    expect(Math.max(...rows.map((row) => row.depth))).toBe(2);
  });
});

describe("stackRows", () => {
  it("keeps the anchor, its parents, and its descendants, but not sibling forks", () => {
    expect(stackRows(fixture, "feature/checkout-api").map((row) => row.layer.name)).toEqual([
      "feature/checkout-api",
      "feature/order-model",
      "main",
    ]);
  });

  it("covers every child when the anchor is the fork point", () => {
    expect(stackRows(fixture, "feature/order-model").map((row) => row.layer.name)).toEqual([
      "feature/checkout-ui",
      "feature/checkout-api",
      "feature/order-model",
      "main",
    ]);
  });

  it("stops at a missing parent and keeps the branch visible", () => {
    const view = { trunks: ["main"], layers: [layer("main", null, []), layer("orphan", "gone", ["child"]), layer("child", "orphan", [])] };
    expect(stackRows(view, "child").map((row) => row.layer.name)).toEqual(["child", "orphan"]);
  });

  it("returns no rows for an unknown anchor", () => {
    expect(stackRows(fixture, "missing")).toEqual([]);
  });
});

describe("downstack", () => {
  it("lists parents down to the trunk", () => {
    expect(downstack(fixture, "feature/checkout-api").map((item) => item.name)).toEqual(["feature/order-model"]);
  });
});

describe("patch ranges", () => {
  const patch = "diff --git a/x b/x\n@@ -8,4 +8,14 @@ fn\n line\n@@ -40 +50,0 @@\n-gone\n";
  it("reads hunk ranges per side", () => {
    expect(patchRanges(patch)).toEqual({ old: [[8, 11], [40, 40]], new: [[8, 21]] });
  });
  it("accepts a range inside one hunk and rejects one outside", () => {
    const ranges = patchRanges(patch);
    expect(validateRange(ranges, "new", 12, 14, false)).toBeNull();
    expect(validateRange(ranges, "new", 30, 31, false)).toMatch(/inside one changed hunk/u);
    expect(validateRange(ranges, "new", 5, 3, false)).toMatch(/end line/u);
    // Private notes can anchor anywhere in the file revision.
    expect(validateRange(ranges, "new", 30, 31, true)).toBeNull();
  });
});

describe("links and keys", () => {
  it("prefers the Graphite URL and never shows a PR number", () => {
    const pr = {
      number: 42,
      title: "Add API",
      url: "https://github.com/acme/app/pull/42",
      graphiteUrl: "https://app.graphite.dev/github/pr/acme/app/42",
      state: "OPEN" as const,
      isDraft: false,
      reviewDecision: null,
      headRefName: "feature/checkout-api",
      headRefOid: "b".repeat(40),
      baseRefName: "feature/order-model",
      checks: "none" as const,
    };
    expect(prLink(pr)).toEqual({ label: "Open in Graphite", url: pr.graphiteUrl });
    expect(prLink({ ...pr, graphiteUrl: null }).label).not.toMatch(/\d/u);
  });

  it("builds the viewed key from both blob ids", () => {
    const oldBlob = "1".repeat(40);
    const newBlob = "2".repeat(40);
    expect(
      fileKey({ path: "a", oldPath: null, status: "M", similarity: null, additions: 1, deletions: 0, binary: false, oldBlob, newBlob, oldMode: "", newMode: "" }),
    ).toBe(`${oldBlob}:${newBlob}`);
  });

  it("listens on the server realtime channel", () => {
    expect(GRAPHITE_CHANGED_CHANNEL).toBe(GRAPHITE_CHANGED);
  });
});
