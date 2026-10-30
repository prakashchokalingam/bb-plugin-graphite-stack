// Pure view-model helpers for the Graphite Stack app. No React, no RPC.
import type { LayerView, StackStatus, StackView } from "../contract";
import type { ChangedFile, PrSummary, WorktreeInfo } from "../lib/model";

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const seconds = Math.round((now - epochMs) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** One row of the stack rail. `depth` grows only at a fork. */
export interface RailRow {
  layer: LayerView;
  depth: number;
  /** True when this row is the first child of a fork (a sibling follows). */
  forked: boolean;
}

/** Extra columns for fork siblings stay bounded; wide trunks have many children. */
const MAX_FORK_COLUMNS = 2;

/**
 * Orders layers like `gt log short`: children above parents, trunk at the
 * bottom of its tree. The first child keeps its parent's column; each other
 * child moves one column right, up to MAX_FORK_COLUMNS.
 */
export function railRows(view: Pick<StackView, "layers" | "trunks">): RailRow[] {
  const byName = new Map(view.layers.map((layer) => [layer.name, layer]));
  const rows: RailRow[] = [];
  const seen = new Set<string>();
  const visit = (name: string, depth: number) => {
    const layer = byName.get(name);
    if (!layer || seen.has(name)) return;
    seen.add(name);
    const children = layer.children.filter((child) => byName.has(child)).sort();
    // Later siblings render first (top), at a deeper column.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      visit(children[index]!, depth + Math.min(index, MAX_FORK_COLUMNS));
    }
    rows.push({ layer, depth, forked: children.length > 1 });
  };
  const trunks = view.trunks.length > 0 ? view.trunks : view.layers.filter((l) => l.trunk).map((l) => l.name);
  for (const trunk of trunks) visit(trunk, 0);
  // Orphans: tracked layers whose parent is not tracked.
  for (const layer of view.layers) {
    if (!seen.has(layer.name) && (layer.parent === null || !byName.has(layer.parent))) {
      visit(layer.name, 0);
    }
  }
  for (const layer of view.layers) if (!seen.has(layer.name)) visit(layer.name, 0);
  return rows;
}

/**
 * The layers in one stack: the anchor, its parents up to a trunk or a missing
 * parent, and every descendant of the anchor. Sibling forks stay out.
 */
export function stackMembers(view: Pick<StackView, "layers">, anchor: string): LayerView[] {
  const byName = new Map(view.layers.map((layer) => [layer.name, layer]));
  const start = byName.get(anchor);
  if (!start) return [];
  const members = new Map<string, LayerView>();
  const up = new Set<string>();
  let cursor: LayerView | undefined = start;
  while (cursor && !up.has(cursor.name)) {
    up.add(cursor.name);
    members.set(cursor.name, cursor);
    if (cursor.trunk || cursor.parent === null) break;
    cursor = byName.get(cursor.parent);
  }
  const visit = (layer: LayerView) => {
    for (const child of layer.children) {
      const next = byName.get(child);
      if (!next || members.has(next.name)) continue;
      members.set(next.name, next);
      visit(next);
    }
  };
  visit(start);
  return view.layers.filter((layer) => members.has(layer.name));
}

/** Rail rows for one stack, in the same order as the full rail. */
export function stackRows(view: Pick<StackView, "layers" | "trunks">, anchor: string): RailRow[] {
  const layers = stackMembers(view, anchor);
  if (layers.length === 0) return [];
  const names = new Set(layers.map((layer) => layer.name));
  return railRows({ layers, trunks: view.trunks.filter((trunk) => names.has(trunk)) });
}

/** Branches below `name` down to (not including) its trunk, nearest first. */
export function downstack(view: Pick<StackView, "layers">, name: string): LayerView[] {
  const byName = new Map(view.layers.map((layer) => [layer.name, layer]));
  const result: LayerView[] = [];
  let cursor = byName.get(name)?.parent ?? null;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const layer = byName.get(cursor);
    if (!layer || layer.trunk) break;
    result.push(layer);
    cursor = layer.parent;
  }
  return result;
}

export function defaultSelection(view: StackView): string | null {
  const current = view.layers.find((layer) => layer.name === view.currentBranch);
  if (current && !current.trunk) return current.name;
  const firstBranch = railRows(view).find((row) => !row.layer.trunk);
  return firstBranch?.layer.name ?? view.layers[0]?.name ?? null;
}

export function untrackedBranches(view: StackView): string[] {
  const tracked = new Set(view.layers.map((layer) => layer.name));
  return view.localBranches.filter((branch) => !tracked.has(branch)).sort();
}

export function worktreeFor(view: StackView, branch: string): WorktreeInfo | null {
  return view.worktrees.find((worktree) => worktree.branch === branch) ?? null;
}

export function worktreeDirtyCount(worktree: WorktreeInfo): number {
  return worktree.staged + worktree.unstaged + worktree.untracked + worktree.conflicted;
}

/** Message and title for every non-ready stack status. */
export function statusCopy(status: StackStatus): { title: string; body: string } {
  switch (status) {
    case "ready":
      return { title: "Ready", body: "" };
    case "no-environment":
      return {
        title: "No environment",
        body: "This thread has no BB environment. Open a thread that works in a Git checkout.",
      };
    case "environment-unavailable":
      return {
        title: "Environment unavailable",
        body: "BB cannot reach this environment or its host. Start the host, then retry.",
      };
    case "no-git":
      return { title: "Git unavailable", body: "Git is not installed on the environment host." };
    case "no-repo":
      return { title: "Not a Git repository", body: "The environment directory is not inside a Git repository." };
    case "no-gt":
      return {
        title: "Graphite CLI unavailable",
        body: "Install the Graphite CLI (gt) on the environment host, then retry.",
      };
    case "gt-uninitialized":
      return {
        title: "Graphite is not initialized",
        body: "Initialize Graphite for this repository and select its trunk branch.",
      };
    case "gt-unsupported":
      return {
        title: "Unsupported Graphite output",
        body: "The installed gt version returned output that this plugin cannot read. Stack actions stay off.",
      };
    case "error":
      return { title: "Cannot read the stack", body: "Graphite or Git returned an error." };
    default:
      return { title: "Unknown state", body: String(status) };
  }
}

export type FileKind = "binary" | "added" | "deleted" | "renamed" | "copied" | "mode" | "modified" | "conflict";

export function fileKind(file: ChangedFile): FileKind {
  if (file.binary) return "binary";
  switch (file.status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "mode";
    case "U":
      return "conflict";
    default:
      return "modified";
  }
}

/** Stable identity of one file revision, for viewed state. */
export function fileKey(file: ChangedFile): string {
  return `${file.oldBlob.slice(0, 40)}:${file.newBlob.slice(0, 40)}`;
}

export function fileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function fileDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** Canonical review link label and URL. Never exposes a raw PR number. */
export function prLink(pr: PrSummary): { label: string; url: string } {
  if (pr.graphiteUrl) return { label: "Open in Graphite", url: pr.graphiteUrl };
  return { label: "Open pull request", url: pr.url };
}

export function prStateLabel(pr: PrSummary): { label: string; tone: Tone } {
  if (pr.state === "MERGED") return { label: "Merged", tone: "brand" };
  if (pr.state === "CLOSED") return { label: "Closed", tone: "muted" };
  if (pr.isDraft) return { label: "Draft", tone: "muted" };
  if (pr.reviewDecision === "APPROVED") return { label: "Approved", tone: "success" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "danger" };
  return { label: "Ready for review", tone: "success" };
}

export function checksLabel(checks: PrSummary["checks"]): { label: string; tone: Tone } | null {
  switch (checks) {
    case "passing":
      return { label: "Checks pass", tone: "success" };
    case "failing":
      return { label: "Checks fail", tone: "danger" };
    case "pending":
      return { label: "Checks running", tone: "warning" };
    default:
      return null;
  }
}

export type Tone = "muted" | "success" | "warning" | "danger" | "brand";

/** Line ranges that a unified patch covers, per side. */
export interface PatchRanges {
  old: Array<[number, number]>;
  new: Array<[number, number]>;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export function patchRanges(patch: string): PatchRanges {
  const ranges: PatchRanges = { old: [], new: [] };
  for (const line of patch.split("\n")) {
    const match = HUNK_RE.exec(line);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (oldCount > 0) ranges.old.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) ranges.new.push([newStart, newStart + newCount - 1]);
  }
  return ranges;
}

/** Null when the range is valid, otherwise the reason. */
export function validateRange(
  ranges: PatchRanges | null,
  side: "old" | "new",
  start: number,
  end: number,
  fullContext: boolean,
): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
    return "Enter line numbers of 1 or more.";
  }
  if (end < start) return "The end line must not be before the start line.";
  if (end - start > 500) return "Select 500 lines or fewer.";
  if (fullContext || ranges === null) return null;
  const sideRanges = ranges[side];
  if (sideRanges.length === 0) {
    return side === "old" ? "This file has no lines on the parent side." : "This file has no lines on the branch side.";
  }
  const inside = sideRanges.some(([from, to]) => start >= from && end <= to);
  return inside ? null : "Select lines inside one changed hunk, or turn on full-file context.";
}

export function anchorLabel(anchor: { path: string; side: "old" | "new"; startLine: number; endLine: number }): string {
  const lines = anchor.startLine === anchor.endLine ? `L${anchor.startLine}` : `L${anchor.startLine}–${anchor.endLine}`;
  return `${fileName(anchor.path)} · ${anchor.side === "old" ? "parent" : "branch"} ${lines}`;
}

export function draftKey(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part ?? "-").join("|").slice(0, 500);
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown error";
}
