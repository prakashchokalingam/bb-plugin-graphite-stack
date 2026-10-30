// Host-side read and write operations over git and gt. Each function takes a
// Runner so that tests can run them against disposable repositories.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProbeResult, ReadStackResult, WorktreeStatus } from "../contract";
import {
  isValidBranchSyntax,
  isSafeRepoPath,
  SHA_RE,
  type BranchNode,
  type CommandResult,
  type FileSidesResult,
  type GtCommand,
  type OperationKind,
  type PatchResult,
  type WorktreeInfo,
} from "./model";
import {
  dropPartialRecord,
  isBinaryContent,
  isGtVersionSupported,
  isGtVersionTested,
  parseGithubRemote,
  parseGtState,
  parseGtVersion,
  parseRawAndNumstat,
  parseStatusV2,
  parseWorktreeList,
  redactSecrets,
  topologyFromState,
} from "./parse";
import { stripAnsi, tail, type Runner } from "./process";

const READ_TIMEOUT = 20_000;
/**
 * Optional locks off for reads, so a status read never blocks a writer.
 * Literal pathspecs, so a path such as `src/a[1].ts` or `:(glob)**` names
 * exactly one file.
 */
const READ_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };

export function safeRealpath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

async function git(run: Runner, cwd: string, args: string[], maxBytes = 4 * 1024 * 1024, timeoutMs = READ_TIMEOUT) {
  return run("git", args, { cwd, maxBytes, timeoutMs, env: READ_ENV });
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function errorText(result: { stderr: string; stdout: string; spawnError: string | null; timedOut: boolean }): string {
  if (result.spawnError !== null) return result.spawnError;
  if (result.timedOut) return "Command timed out";
  return tail(redactSecrets(stripAnsi(result.stderr.trim() || result.stdout.trim())) || "Command failed", 600);
}

/** Validate a branch name with our pattern and with git itself. */
export async function isValidBranchName(run: Runner, cwd: string, name: string): Promise<boolean> {
  if (!isValidBranchSyntax(name)) return false;
  const result = await git(run, cwd, ["check-ref-format", "--branch", name]);
  return result.exitCode === 0;
}

/** Resolve a local branch to a full commit SHA, or null. */
export async function resolveBranch(run: Runner, cwd: string, branch: string): Promise<string | null> {
  if (!isValidBranchSyntax(branch)) return null;
  const result = await git(run, cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  const sha = result.stdout.trim();
  return result.exitCode === 0 && SHA_RE.test(sha) ? sha : null;
}

/** Confirm that a SHA names a commit in this repository. */
export async function verifyCommit(run: Runner, cwd: string, sha: string): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false;
  const result = await git(run, cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]);
  return result.exitCode === 0 && result.stdout.trim() === sha;
}

export async function probe(run: Runner, cwd: string): Promise<ProbeResult> {
  const result: ProbeResult = {
    git: { available: false, version: null },
    repo: null,
    graphite: { available: false, version: null, tested: false, initialized: false },
    gh: { available: false },
    error: null,
  };
  if (!existsSync(cwd)) {
    result.error = "The environment path does not exist on this host";
    return result;
  }
  const [gitVersion, gtVersion, ghVersion] = await Promise.all([
    run("git", ["--version"], { cwd, timeoutMs: 10_000, maxBytes: 4096 }),
    run("gt", ["--version"], { cwd, timeoutMs: 15_000, maxBytes: 4096 }),
    run("gh", ["--version"], { cwd, timeoutMs: 10_000, maxBytes: 4096 }),
  ]);
  if (gitVersion.exitCode === 0) {
    result.git = { available: true, version: firstLine(gitVersion.stdout).replace(/^git version /u, "") };
  } else {
    result.error = "git is not available on this host";
    return result;
  }
  if (gtVersion.exitCode === 0) {
    const version = parseGtVersion(gtVersion.stdout);
    result.graphite.available = version !== null;
    result.graphite.version = version;
    result.graphite.tested = isGtVersionTested(version);
  }
  result.gh.available = ghVersion.exitCode === 0;

  const revParse = await git(run, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
    "--absolute-git-dir",
  ]);
  if (revParse.exitCode !== 0) return result;
  const [root, commonDir, gitDir] = revParse.stdout.trim().split("\n");
  if (root === undefined || commonDir === undefined || gitDir === undefined) return result;
  const [branch, head] = await Promise.all([
    git(run, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(run, cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
  ]);
  const headSha = head.stdout.trim();
  result.repo = {
    root: safeRealpath(root),
    commonDir: safeRealpath(commonDir),
    gitDir: safeRealpath(gitDir),
    currentBranch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    headSha: SHA_RE.test(headSha) ? headSha : null,
  };
  // Existence check only. The plugin never reads or writes Graphite's files.
  result.graphite.initialized = existsSync(path.join(result.repo.commonDir, ".graphite_repo_config"));
  return result;
}

/** Detect an in-progress git operation in one worktree's git dir. */
export function detectOperation(gitDir: string): OperationKind | null {
  if (existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

export async function worktreeStatus(run: Runner, worktreePath: string): Promise<{ status: WorktreeStatus | null; error: string | null }> {
  const [status, gitDir] = await Promise.all([
    git(run, worktreePath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], 2 * 1024 * 1024),
    git(run, worktreePath, ["rev-parse", "--absolute-git-dir"]),
  ]);
  if (status.exitCode !== 0 || gitDir.exitCode !== 0) {
    return { status: null, error: errorText(status.exitCode !== 0 ? status : gitDir) };
  }
  const parsed = parseStatusV2(dropPartialRecord(status.stdout, status.truncated), 0);
  return {
    status: {
      path: safeRealpath(worktreePath),
      branch: parsed.branch,
      headSha: parsed.headSha,
      staged: parsed.staged,
      unstaged: parsed.unstaged,
      untracked: parsed.untracked,
      conflicted: parsed.conflicted,
      operation: detectOperation(gitDir.stdout.trim()),
    },
    error: status.truncated ? "git status output exceeded the byte cap; counts are partial" : null,
  };
}

/** Run `gt state` and validate it. Callers must check initialization first. */
export async function readGtState(run: Runner, cwd: string) {
  const result = await run("gt", ["state", "--no-interactive"], { cwd, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  if (result.exitCode !== 0 || result.truncated) {
    return { ok: false as const, kind: "gt-failed" as const, error: result.truncated ? "gt state output exceeded the byte cap" : errorText(result) };
  }
  const parsed = parseGtState(stripAnsi(result.stdout));
  if (!parsed.ok) return { ok: false as const, kind: "unsupported-output" as const, error: parsed.error };
  return { ok: true as const, state: parsed.state };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readStack(
  run: Runner,
  cwd: string,
  environmentPaths: readonly { id: string; path: string }[],
  commitLimit: number,
  detailBranches?: readonly string[],
): Promise<ReadStackResult> {
  const anchorRealpath = safeRealpath(cwd);
  const empty: ReadStackResult = {
    ok: false,
    error: null,
    errorKind: null,
    trunks: [],
    branches: [],
    worktrees: [],
    anchorRealpath,
    remote: null,
    remoteName: null,
    localBranches: [],
  };
  const commonDirResult = await git(run, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDirResult.exitCode !== 0) return { ...empty, error: errorText(commonDirResult), errorKind: "git-failed" };
  const commonDir = safeRealpath(commonDirResult.stdout.trim());
  if (!existsSync(path.join(commonDir, ".graphite_repo_config"))) {
    return { ...empty, error: "Graphite is not initialized in this repository", errorKind: "gt-failed" };
  }

  const [gtState, refs, worktreeList] = await Promise.all([
    readGtState(run, cwd),
    git(run, cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"], 4 * 1024 * 1024),
    git(run, cwd, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  if (!gtState.ok) return { ...empty, error: gtState.error, errorKind: gtState.kind };
  if (refs.exitCode !== 0 || refs.truncated) {
    return { ...empty, error: refs.truncated ? "Branch list exceeded the byte cap" : errorText(refs), errorKind: "git-failed" };
  }

  if (worktreeList.exitCode !== 0 || worktreeList.truncated) {
    return { ...empty, error: worktreeList.truncated ? "git worktree list exceeded the byte cap" : errorText(worktreeList), errorKind: "git-failed" };
  }

  const heads = new Map<string, string>();
  for (const line of refs.stdout.split("\n")) {
    const [name, sha] = line.split("\0");
    if (name && sha && SHA_RE.test(sha)) heads.set(name, sha);
  }
  const topology = topologyFromState(gtState.state);
  const requested = detailBranches === undefined ? null : new Set(detailBranches);
  const branchesPromise: Promise<BranchNode[]> = mapLimit(topology.branches, 8, async (branch) => {
    const headSha = heads.get(branch.name) ?? null;
    const node: BranchNode = {
      ...branch,
      headSha,
      commits: [],
      commitCount: 0,
      commitsTruncated: false,
      detailsLoaded: requested === null || requested.has(branch.name),
    };
    if (!node.detailsLoaded) return node;
    if (branch.trunk || branch.parent === null || headSha === null) return node;
    const parentHead = heads.get(branch.parent) ?? null;
    if (parentHead === null) return node;
    const log = await git(run, cwd, [
      "log",
      "--no-color",
      `--max-count=${commitLimit + 1}`,
      "--format=%H%x00%s%x00%an%x00%ct",
      headSha,
      `^${parentHead}`,
      "--",
    ]);
    if (log.exitCode !== 0) return node;
    const commits = log.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, subject, author, time] = line.split("\0");
        return { sha: sha ?? "", subject: subject ?? "", author: author ?? "", time: Number(time ?? 0) };
      })
      .filter((commit) => SHA_RE.test(commit.sha));
    node.commitsTruncated = commits.length > commitLimit;
    node.commits = commits.slice(0, commitLimit);
    node.commitCount = node.commitsTruncated
      ? await countCommits(run, cwd, headSha, parentHead, commits.length)
      : node.commits.length;
    return node;
  });

  const envByPath = new Map<string, string[]>();
  for (const env of environmentPaths) {
    const real = safeRealpath(env.path);
    const list = envByPath.get(real) ?? [];
    if (!list.includes(env.id)) list.push(env.id);
    envByPath.set(real, list);
  }
  const entries = parseWorktreeList(worktreeList.stdout);
  const worktreesPromise: Promise<WorktreeInfo[]> = mapLimit(entries, 4, async (entry) => {
    const real = safeRealpath(entry.path);
    const base: WorktreeInfo = {
      path: real,
      branch: entry.branch,
      headSha: entry.headSha,
      detached: entry.detached,
      bare: entry.bare,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      operation: null,
      environmentId: envByPath.get(real)?.[0] ?? null,
      environmentIds: envByPath.get(real) ?? [],
      isAnchor: real === anchorRealpath,
      statusError: null,
    };
    if (requested !== null && (entry.branch === null || !requested.has(entry.branch))) {
      return { ...base, statusError: "Status not loaded" };
    }
    if (entry.bare || !existsSync(real)) {
      return { ...base, statusError: entry.bare ? null : "Worktree path is missing" };
    }
    const status = await worktreeStatus(run, real);
    if (status.status === null) return { ...base, statusError: status.error };
    return {
      ...base,
      staged: status.status.staged,
      unstaged: status.status.unstaged,
      untracked: status.status.untracked,
      conflicted: status.status.conflicted,
      operation: status.status.operation,
      statusError: status.error,
    };
  });

  const [branches, worktrees, { remote, remoteName }] = await Promise.all([branchesPromise, worktreesPromise, readRemote(run, cwd)]);

  const tracked = new Set(topology.branches.map((branch) => branch.name));
  return {
    ok: true,
    error: null,
    errorKind: null,
    trunks: topology.trunks,
    branches,
    worktrees,
    anchorRealpath,
    remote,
    remoteName,
    localBranches: [...heads.keys()].filter((name) => !tracked.has(name)).sort().slice(0, 500),
  };
}

async function countCommits(run: Runner, cwd: string, head: string, parent: string, fallback: number): Promise<number> {
  const result = await git(run, cwd, ["rev-list", "--count", head, `^${parent}`, "--"]);
  const count = Number(result.stdout.trim());
  return result.exitCode === 0 && Number.isFinite(count) ? count : fallback;
}

async function readRemote(run: Runner, cwd: string) {
  const remotes = await git(run, cwd, ["remote"]);
  const names = remotes.exitCode === 0 ? remotes.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : [];
  const remoteName = names.includes("origin") ? "origin" : (names[0] ?? null);
  if (remoteName === null) return { remote: null, remoteName: null };
  const url = await git(run, cwd, ["remote", "get-url", "--", remoteName]);
  return { remote: url.exitCode === 0 ? parseGithubRemote(remoteName, url.stdout.trim()) : null, remoteName };
}

/** Graphite topology only: `gt state` plus the remote. No per-branch reads. */
export async function topology(run: Runner, cwd: string) {
  const base = { ok: false, error: null as string | null, commonDir: null as string | null, trunks: [] as string[], branches: [] as ReturnType<typeof topologyFromState>["branches"], remote: null as ReturnType<typeof parseGithubRemote>, remoteName: null as string | null };
  const commonDirResult = await git(run, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDirResult.exitCode !== 0) return { ...base, error: errorText(commonDirResult), errorKind: "git-failed" as const };
  const commonDir = safeRealpath(commonDirResult.stdout.trim());
  if (!existsSync(path.join(commonDir, ".graphite_repo_config"))) {
    return { ...base, commonDir, error: "Graphite is not initialized in this repository", errorKind: "uninitialized" as const };
  }
  const [state, remote] = await Promise.all([readGtState(run, cwd), readRemote(run, cwd)]);
  if (!state.ok) return { ...base, commonDir, error: state.error, errorKind: state.kind };
  const topo = topologyFromState(state.state);
  return { ok: true, error: null, errorKind: null, commonDir, trunks: topo.trunks, branches: topo.branches, ...remote };
}

/** Pinned SHAs for one layer: branch head, parent head, and their merge base. */
export async function snapshot(run: Runner, cwd: string, branch: string, parent: string) {
  const [headSha, parentSha] = await Promise.all([resolveBranch(run, cwd, branch), resolveBranch(run, cwd, parent)]);
  if (headSha === null) return { snapshot: null, error: `Branch ${branch} does not exist` };
  if (parentSha === null) return { snapshot: null, error: `Parent branch ${parent} does not exist` };
  const mergeBase = await git(run, cwd, ["merge-base", "--end-of-options", parentSha, headSha]);
  const baseSha = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !SHA_RE.test(baseSha)) {
    return { snapshot: null, error: `${branch} and ${parent} have no common history` };
  }
  return { snapshot: { branch, parent, headSha, parentSha, baseSha, diverged: baseSha !== parentSha }, error: null };
}

export async function layerFiles(run: Runner, cwd: string, branch: string, parent: string, maxFiles: number) {
  const pinned = await snapshot(run, cwd, branch, parent);
  if (pinned.snapshot === null) return { snapshot: null, files: [], truncated: false, error: pinned.error };
  const { headSha, baseSha } = pinned.snapshot;
  const range = [baseSha, headSha];
  const [raw, numstat] = await Promise.all([
    git(run, cwd, ["diff", "--no-color", "--no-ext-diff", "--raw", "-z", "--find-renames", "--abbrev=40", "--end-of-options", ...range]),
    git(run, cwd, ["diff", "--no-color", "--no-ext-diff", "--numstat", "-z", "--find-renames", "--end-of-options", ...range]),
  ]);
  if (raw.exitCode !== 0) return { snapshot: null, files: [], truncated: false, error: errorText(raw) };
  const files = parseRawAndNumstat(
    dropPartialRecord(raw.stdout, raw.truncated),
    numstat.exitCode === 0 ? dropPartialRecord(numstat.stdout, numstat.truncated) : "",
  );
  return {
    snapshot: pinned.snapshot,
    files: files.slice(0, maxFiles),
    truncated: raw.truncated || files.length > maxFiles,
    error: null,
  };
}

export async function filePatch(
  run: Runner,
  cwd: string,
  baseSha: string,
  headSha: string,
  filePath: string,
  oldPath: string | null,
  maxBytes: number,
): Promise<PatchResult> {
  if (!isSafeRepoPath(filePath) || (oldPath !== null && !isSafeRepoPath(oldPath))) {
    throw new Error("Invalid path");
  }
  if (!(await verifyCommit(run, cwd, baseSha)) || !(await verifyCommit(run, cwd, headSha))) {
    throw new Error("Snapshot commit is not available; refresh the stack");
  }
  const paths = oldPath !== null && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  const result = await git(
    run,
    cwd,
    ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--end-of-options", baseSha, headSha, "--", ...paths],
    maxBytes,
  );
  if (result.exitCode !== 0) throw new Error(errorText(result));
  return {
    patch: result.stdout,
    bytes: result.stdoutBytes,
    truncated: result.truncated,
    binary: /^Binary files .* differ$/mu.test(result.stdout) || result.stdout.includes("\nGIT binary patch"),
  };
}

async function blobAt(run: Runner, cwd: string, sha: string, filePath: string, maxBytes: number) {
  const size = await git(run, cwd, ["cat-file", "-s", "--end-of-options", `${sha}:${filePath}`]);
  if (size.exitCode !== 0) return { state: "missing" as const };
  const bytes = Number(size.stdout.trim());
  if (!Number.isFinite(bytes) || bytes > maxBytes) return { state: "too-large" as const };
  const result = await run("git", ["cat-file", "blob", "--end-of-options", `${sha}:${filePath}`], {
    cwd,
    maxBytes: maxBytes + 1,
    timeoutMs: READ_TIMEOUT,
    env: READ_ENV,
  });
  if (result.exitCode !== 0) return { state: "missing" as const };
  const buffer = Buffer.from(result.stdout, "utf8");
  if (isBinaryContent(buffer) || result.stdout.includes("�")) return { state: "binary" as const };
  return { state: "ok" as const, content: result.stdout };
}

export async function fileSides(
  run: Runner,
  cwd: string,
  baseSha: string,
  headSha: string,
  filePath: string,
  oldPath: string | null,
  maxBytes: number,
): Promise<FileSidesResult> {
  if (!isSafeRepoPath(filePath) || (oldPath !== null && !isSafeRepoPath(oldPath))) throw new Error("Invalid path");
  if (!(await verifyCommit(run, cwd, baseSha)) || !(await verifyCommit(run, cwd, headSha))) {
    throw new Error("Snapshot commit is not available; refresh the stack");
  }
  const oldSidePath = oldPath ?? filePath;
  const [oldSide, newSide] = await Promise.all([
    blobAt(run, cwd, baseSha, oldSidePath, maxBytes),
    blobAt(run, cwd, headSha, filePath, maxBytes),
  ]);
  if (oldSide.state === "too-large" || newSide.state === "too-large") {
    return { status: "too-large", old: null, new: null, message: `A file side is larger than ${maxBytes} bytes` };
  }
  if (oldSide.state === "binary" || newSide.state === "binary") {
    return { status: "binary", old: null, new: null, message: "Binary content has no text context" };
  }
  return {
    status: "ok",
    // A missing side (added or deleted file) is empty text.
    old: { path: oldSidePath, content: oldSide.state === "ok" ? oldSide.content : "" },
    new: { path: filePath, content: newSide.state === "ok" ? newSide.content : "" },
    message: null,
  };
}

export async function uncommitted(run: Runner, worktreePath: string, maxFiles: number) {
  const status = await git(run, worktreePath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], 4 * 1024 * 1024);
  if (status.exitCode !== 0) {
    return { headSha: null, branch: null, files: [], truncated: false, error: errorText(status) };
  }
  const parsed = parseStatusV2(dropPartialRecord(status.stdout, status.truncated), maxFiles);
  return {
    headSha: parsed.headSha,
    branch: parsed.branch,
    files: parsed.files,
    truncated: parsed.truncated || status.truncated,
    error: null,
  };
}

export async function uncommittedPatch(
  run: Runner,
  worktreePath: string,
  filePath: string,
  untracked: boolean,
  maxBytes: number,
): Promise<PatchResult> {
  if (!isSafeRepoPath(filePath)) throw new Error("Invalid path");
  const result = untracked
    ? await run("git", ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", filePath], {
        cwd: worktreePath,
        maxBytes,
        timeoutMs: READ_TIMEOUT,
        env: READ_ENV,
      })
    : await git(run, worktreePath, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", filePath], maxBytes);
  // `git diff --no-index` exits 1 when files differ.
  if (result.exitCode !== 0 && !(untracked && result.exitCode === 1)) throw new Error(errorText(result));
  return {
    patch: result.stdout,
    bytes: result.stdoutBytes,
    truncated: result.truncated,
    binary: /^Binary files .* differ$/mu.test(result.stdout),
  };
}

export async function readLines(run: Runner, cwd: string, sha: string, filePath: string, start: number, end: number) {
  if (end < start || end - start > 500) return { lines: null, error: "Line range is too large" };
  if (!(await verifyCommit(run, cwd, sha))) return { lines: null, error: "Commit is not available" };
  const blob = await blobAt(run, cwd, sha, filePath, 2 * 1024 * 1024);
  if (blob.state !== "ok") return { lines: null, error: `File content is ${blob.state}` };
  const lines = blob.content.split("\n");
  if (end > lines.length) return { lines: null, error: "Line is outside the file" };
  return { lines: lines.slice(start - 1, end), error: null };
}

/**
 * An anchor is current when the same text is at the same line range on the
 * same side of the current snapshot. Otherwise it is outdated. The original SHA,
 * path, side, and line stay on the record.
 */
export async function checkAnchors(
  run: Runner,
  cwd: string,
  baseSha: string,
  headSha: string,
  anchors: readonly { id: string; path: string; side: "old" | "new"; startLine: number; endLine: number; text: string }[],
) {
  const results: Record<string, "current" | "outdated" | "unknown"> = {};
  const cache = new Map<string, string[] | null>();
  for (const anchor of anchors) {
    const sha = anchor.side === "new" ? headSha : baseSha;
    const key = `${sha}:${anchor.path}`;
    if (!cache.has(key)) {
      if (!(await verifyCommit(run, cwd, sha))) {
        cache.set(key, null);
      } else {
        const blob = await blobAt(run, cwd, sha, anchor.path, 2 * 1024 * 1024);
        cache.set(key, blob.state === "ok" ? blob.content.split("\n") : blob.state === "missing" ? [] : null);
      }
    }
    const lines = cache.get(key);
    if (lines === null || lines === undefined) {
      results[anchor.id] = "unknown";
      continue;
    }
    // The whole selected range must still read the same at the same lines.
    const current = anchor.endLine <= lines.length ? lines.slice(anchor.startLine - 1, anchor.endLine).join("\n") : null;
    results[anchor.id] = current === anchor.text ? "current" : "outdated";
  }
  return { results };
}

/** Build the exact gt argv for a validated command. */
export function gtArgv(command: GtCommand): string[] {
  switch (command.kind) {
    case "init":
      return ["init", "--trunk", command.trunk, "--no-interactive"];
    case "create":
      return [
        "create",
        command.name,
        "--message",
        command.message,
        ...(command.stageAll ? ["--all"] : []),
        "--no-ai",
        "--no-interactive",
      ];
    case "track":
      return ["track", command.branch, "--parent", command.parent, "--no-interactive"];
    case "restack-only":
      return ["restack", "--only", "--branch", command.branch, "--no-interactive"];
    case "sync":
      return ["sync", "--no-interactive"];
    case "submit":
      return [
        "submit",
        "--branch",
        command.branch,
        command.stack ? "--stack" : "--no-stack",
        "--draft",
        "--no-edit",
        "--no-ai",
        ...(command.dryRun ? ["--dry-run"] : []),
        "--no-interactive",
      ];
    case "continue":
      return ["continue", "--no-interactive"];
    case "abort":
      return ["abort", "--force", "--no-interactive"];
  }
}

export async function runGt(run: Runner, cwd: string, command: GtCommand, timeoutMs: number): Promise<CommandResult> {
  for (const name of branchArgs(command)) {
    if (!(await isValidBranchName(run, cwd, name))) {
      return { exitCode: null, stdout: "", stderr: `Invalid branch name: ${name}`, timedOut: false, truncated: false, argv: [] };
    }
  }
  const argv = gtArgv(command);
  const result = await run("gt", argv, { cwd, timeoutMs, maxBytes: 1024 * 1024 });
  return {
    exitCode: result.exitCode,
    stdout: tail(redactSecrets(stripAnsi(result.stdout))),
    stderr: tail(redactSecrets(stripAnsi(result.spawnError ?? result.stderr))),
    timedOut: result.timedOut,
    truncated: result.truncated,
    argv: ["gt", ...argv],
  };
}

function branchArgs(command: GtCommand): string[] {
  switch (command.kind) {
    case "init":
      return [command.trunk];
    case "create":
      return [command.name];
    case "track":
      return [command.branch, command.parent];
    case "restack-only":
    case "submit":
      return [command.branch];
    default:
      return [];
  }
}

export async function refHeads(run: Runner, cwd: string, branches: readonly string[]) {
  const heads: Record<string, string | null> = {};
  for (const branch of branches) heads[branch] = await resolveBranch(run, cwd, branch);
  return { heads };
}
