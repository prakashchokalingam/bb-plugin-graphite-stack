// Pure parsers for git, gt, and gh output. No I/O here, so tests can feed
// recorded fixtures.
import {
  gtStateSchema,
  isSafeRepoPath,
  SHA_RE,
  type ChangedFile,
  type FileStatus,
  type GithubRemote,
  type GtState,
  type UncommittedFile,
} from "./model";

export const GT_TESTED_VERSIONS = ["1.8.6"] as const;
/** Versions whose `gt state` output is accepted after schema validation. */
export const GT_SUPPORTED_RANGE = { minMajor: 1, minMinor: 8, maxMajorExclusive: 2 } as const;

export function parseGtVersion(stdout: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(stdout);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

export function isGtVersionSupported(version: string | null): boolean {
  if (version === null) return false;
  const [major, minor] = version.split(".").map((part) => Number(part));
  if (major === undefined || minor === undefined) return false;
  if (major >= GT_SUPPORTED_RANGE.maxMajorExclusive) return false;
  if (major > GT_SUPPORTED_RANGE.minMajor) return true;
  return major === GT_SUPPORTED_RANGE.minMajor && minor >= GT_SUPPORTED_RANGE.minMinor;
}

export function isGtVersionTested(version: string | null): boolean {
  return version !== null && (GT_TESTED_VERSIONS as readonly string[]).includes(version);
}

export type GtStateParse =
  | { ok: true; state: GtState }
  | { ok: false; error: string };

/**
 * Parse `gt state` stdout. gt can print tips before the JSON document, so
 * the parser takes the text from the first line that starts with `{` to the
 * last `}`. The result must pass the schema, every non-trunk branch must have
 * exactly one parent. Missing parents remain explicit graph boundaries.
 */
export function parseGtState(stdout: string): GtStateParse {
  const lines = stdout.split("\n");
  const startLine = lines.findIndex((line) => line.trimStart().startsWith("{"));
  const end = stdout.lastIndexOf("}");
  if (startLine < 0 || end < 0) return { ok: false, error: "gt state printed no JSON document" };
  const start = lines.slice(0, startLine).reduce((sum, line) => sum + line.length + 1, 0);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `gt state JSON did not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = gtStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `gt state output has an unsupported shape: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const state = parsed.data;
  const names = Object.keys(state);
  if (!names.some((name) => state[name]!.trunk)) return { ok: false, error: "gt state lists no trunk branch" };
  for (const name of names) {
    const entry = state[name]!;
    if (entry.trunk) continue;
    const parents = entry.parents ?? [];
    if (parents.length !== 1) {
      return { ok: false, error: `Branch ${name} has ${parents.length} Graphite parents; expected exactly one` };
    }
    const parentRef = parents[0]!.ref;
    if (parentRef === name) return { ok: false, error: `Branch ${name} is its own Graphite parent` };
  }
  // Walk known entries only. A missing parent is an incomplete graph, not invalid JSON.
  // Never resolve inherited object properties as Graphite branches.
  for (const name of names) {
    const seen = new Set<string>();
    let current = name;
    while (Object.hasOwn(state, current) && !state[current]!.trunk) {
      if (seen.has(current)) return { ok: false, error: `Graphite parents form a cycle at ${current}` };
      seen.add(current);
      current = state[current]!.parents![0]!.ref;
    }
  }
  return { ok: true, state };
}

export interface TopologyBranch {
  name: string;
  trunk: boolean;
  parent: string | null;
  parentRecordedSha: string | null;
  needsRestack: boolean;
}

export function topologyFromState(state: GtState): { trunks: string[]; branches: TopologyBranch[] } {
  const trunks: string[] = [];
  const branches: TopologyBranch[] = [];
  for (const [name, entry] of Object.entries(state)) {
    if (entry.trunk) trunks.push(name);
    const parent = entry.trunk ? null : (entry.parents?.[0] ?? null);
    branches.push({
      name,
      trunk: entry.trunk,
      parent: parent?.ref ?? null,
      parentRecordedSha: parent?.sha ?? null,
      needsRestack: entry.needs_restack ?? false,
    });
  }
  return { trunks, branches };
}

/** Children per branch, sorted by name for stable output. */
export function childrenOf(branches: readonly { name: string; parent: string | null }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const branch of branches) map.set(branch.name, []);
  for (const branch of branches) {
    if (branch.parent !== null) map.get(branch.parent)?.push(branch.name);
  }
  for (const list of map.values()) list.sort();
  return map;
}

/** Ancestors from the branch's parent up to its trunk. */
export function ancestorsOf(name: string, parentOf: Map<string, string | null>): string[] {
  const result: string[] = [];
  const seen = new Set<string>([name]);
  let current = parentOf.get(name) ?? null;
  while (current !== null && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return result;
}

/** Descendants in parent-before-child order. */
export function descendantsOf(name: string, children: Map<string, string[]>): string[] {
  const result: string[] = [];
  const queue = [...(children.get(name) ?? [])];
  const seen = new Set<string>([name]);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return result;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current !== null) entries.push(current);
      current = { path: field.slice(9), headSha: null, branch: null, detached: false, bare: false };
    } else if (current === null) {
      continue;
    } else if (field.startsWith("HEAD ")) {
      const sha = field.slice(5);
      current.headSha = SHA_RE.test(sha) ? sha : null;
    } else if (field.startsWith("branch ")) {
      const ref = field.slice(7);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
    } else if (field === "detached") {
      current.detached = true;
    } else if (field === "bare") {
      current.bare = true;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

export interface StatusSummary {
  branch: string | null;
  headSha: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  files: UncommittedFile[];
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(output: string, maxFiles = Number.POSITIVE_INFINITY): StatusSummary & { truncated: boolean } {
  const summary: StatusSummary = {
    branch: null,
    headSha: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
  };
  let truncated = false;
  const fields = output.split("\0");
  const push = (file: UncommittedFile) => {
    if (summary.files.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (!isSafeRepoPath(file.path)) return;
    summary.files.push(file);
  };
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === "") continue;
    if (field.startsWith("# branch.oid ")) {
      const sha = field.slice(13);
      summary.headSha = SHA_RE.test(sha) ? sha : null;
    } else if (field.startsWith("# branch.head ")) {
      const head = field.slice(14);
      summary.branch = head === "(detached)" ? null : head;
    } else if (field.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const parts = field.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      countXY(summary, xy);
      push({ path, oldPath: null, index: xy[0]!, worktree: xy[1]!, untracked: false, conflicted: false });
    } else if (field.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const parts = field.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      const oldPath = fields[index + 1] ?? null;
      index += 1;
      countXY(summary, xy);
      push({ path, oldPath, index: xy[0]!, worktree: xy[1]!, untracked: false, conflicted: false });
    } else if (field.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = field.split(" ");
      const xy = parts[1] ?? "UU";
      summary.conflicted += 1;
      push({ path: parts.slice(10).join(" "), oldPath: null, index: xy[0]!, worktree: xy[1]!, untracked: false, conflicted: true });
    } else if (field.startsWith("? ")) {
      summary.untracked += 1;
      push({ path: field.slice(2), oldPath: null, index: "?", worktree: "?", untracked: true, conflicted: false });
    }
  }
  return { ...summary, truncated };
}

function countXY(summary: StatusSummary, xy: string) {
  if (xy[0] !== ".") summary.staged += 1;
  if (xy[1] !== ".") summary.unstaged += 1;
}

/**
 * Parse `git diff --raw -z --find-renames` and `git diff --numstat -z
 * --find-renames` for the same range into one file list.
 */
export function parseRawAndNumstat(raw: string, numstat: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const rawFields = raw.split("\0");
  for (let index = 0; index < rawFields.length; index += 1) {
    const header = rawFields[index]!;
    if (!header.startsWith(":")) continue;
    // :oldmode newmode oldsha newsha status
    const [oldMode, newMode, oldBlob, newBlob, statusField] = header.slice(1).split(" ");
    if (statusField === undefined) continue;
    const letter = statusField[0] as FileStatus;
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : null;
    if (letter === "R" || letter === "C") {
      const oldPath = rawFields[index + 1] ?? "";
      const path = rawFields[index + 2] ?? "";
      index += 2;
      files.push(makeFile(path, oldPath, letter, score, oldMode!, newMode!, oldBlob!, newBlob!));
    } else {
      const path = rawFields[index + 1] ?? "";
      index += 1;
      files.push(makeFile(path, null, letter, null, oldMode!, newMode!, oldBlob!, newBlob!));
    }
  }
  const stats = parseNumstat(numstat);
  for (const file of files) {
    const stat = stats.get(file.path);
    if (stat === undefined) continue;
    file.additions = stat.additions;
    file.deletions = stat.deletions;
    file.binary = stat.binary;
  }
  return files.filter((file) => isSafeRepoPath(file.path) && (file.oldPath === null || isSafeRepoPath(file.oldPath)));
}

function makeFile(
  path: string,
  oldPath: string | null,
  status: FileStatus,
  similarity: number | null,
  oldMode: string,
  newMode: string,
  oldBlob: string,
  newBlob: string,
): ChangedFile {
  return {
    path,
    oldPath,
    status: (["A", "M", "D", "R", "C", "T", "U"] as const).includes(status) ? status : "M",
    similarity: Number.isFinite(similarity) ? similarity : null,
    additions: null,
    deletions: null,
    binary: false,
    oldBlob,
    newBlob,
    oldMode,
    newMode,
  };
}

/** Parse `git diff --numstat -z`; keyed by the new path. */
export function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const map = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === "") continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(field);
    if (match === null) continue;
    const binary = match[1] === "-" && match[2] === "-";
    let path = match[3]!;
    if (path === "") {
      // Rename: the next two fields are the old and the new path.
      path = fields[index + 2] ?? "";
      index += 2;
    }
    map.set(path, {
      additions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
      binary,
    });
  }
  return map;
}

/** Parse a GitHub remote URL (https, ssh, or scp-like). */
export function parseGithubRemote(remote: string, url: string): GithubRemote | null {
  const trimmed = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u,
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u,
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match === null) continue;
    const host = match[1]!.toLowerCase();
    // Only github.com and GitHub Enterprise Cloud (*.ghe.com) are trusted API hosts.
    if (host !== "github.com" && !/^[a-z0-9-]+\.ghe\.com$/u.test(host)) return null;
    const owner = match[2]!;
    const repo = match[3]!;
    const valid = (part: string) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..";
    if (!valid(owner) || !valid(repo)) return null;
    return { remote, url: redactUrl(trimmed), host, owner, repo };
  }
  return null;
}

/** Remove credentials from a URL before it leaves the host. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/iu, "$1");
}

/** Remove URL user info and common token shapes from tool output. */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/giu, "$1")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/gu, "[redacted]")
    .replace(/(authorization:\s*(?:bearer|token|basic)\s+)\S+/giu, "$1[redacted]");
}

/** Drop a partial trailing record from capped `-z` output. */
export function dropPartialRecord(output: string, truncated: boolean): string {
  if (!truncated) return output;
  const end = output.lastIndexOf("\0");
  return end < 0 ? "" : output.slice(0, end + 1);
}

/** Canonical Graphite PR link. */
export function graphitePrUrl(owner: string, repo: string, number: number): string {
  return `https://app.graphite.com/github/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;
}

export function isBinaryContent(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
