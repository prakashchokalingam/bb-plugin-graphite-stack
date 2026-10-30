// Shared domain schemas for the Graphite Stack plugin. The host entry, the
// server entry, and the app use these. The app imports types only.
import { z } from "zod";

export const SHA_RE = /^[0-9a-f]{40}$/u;
export const shaSchema = z.string().regex(SHA_RE, "Expected a full 40-character commit SHA");

/** Repository-relative path. No absolute paths, no `..` segments, no NUL. */
export const repoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isSafeRepoPath(value), "Invalid repository path");

/**
 * Paths are passed after `--` with literal pathspecs, so a leading `-` and
 * glob characters are ordinary file names.
 */
export function isSafeRepoPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
  return !value.split("/").some((segment) => segment === ".." || segment === "");
}

/**
 * Git-compatible branch-name syntax (git check-ref-format rules), with one
 * extra rule: no leading `-`, so a name never reads as an option. Unicode and
 * `@` are allowed. The host also runs `git check-ref-format --branch`.
 */
export function isValidBranchSyntax(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-") || name === "@" || name === "HEAD") return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/u.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
export const branchSchema = z.string().refine(isValidBranchSyntax, "Invalid branch name");

export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), "Expected an absolute path");

// ---------------------------------------------------------------------------
// Graphite topology (from `gt state`)
// ---------------------------------------------------------------------------

export const gtStateEntrySchema = z.object({
  trunk: z.boolean(),
  needs_restack: z.boolean().optional(),
  parents: z
    .array(z.object({ ref: z.string().min(1), sha: z.string().regex(SHA_RE) }))
    .optional(),
});
export const gtStateSchema = z.record(z.string().min(1), gtStateEntrySchema);
export type GtState = z.infer<typeof gtStateSchema>;

export const commitSummarySchema = z.object({
  sha: shaSchema,
  subject: z.string(),
  author: z.string(),
  time: z.number(),
});
export type CommitSummary = z.infer<typeof commitSummarySchema>;

export const branchNodeSchema = z.object({
  name: z.string(),
  trunk: z.boolean(),
  /** Graphite parent branch name. Null for a trunk. */
  parent: z.string().nullable(),
  /** Parent revision that Graphite recorded for this branch. */
  parentRecordedSha: z.string().nullable(),
  needsRestack: z.boolean(),
  /** Local head of `refs/heads/<name>`, or null when the ref is missing. */
  headSha: z.string().nullable(),
  /** Commits in this branch that are not in its parent (newest first). */
  commits: z.array(commitSummarySchema),
  commitCount: z.number(),
  commitsTruncated: z.boolean(),
  /** False when commit details have not been read yet. */
  detailsLoaded: z.boolean().optional(),
});
export type BranchNode = z.infer<typeof branchNodeSchema>;

export const operationKindSchema = z.enum(["rebase", "merge", "cherry-pick", "revert"]);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const worktreeInfoSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  staged: z.number(),
  unstaged: z.number(),
  untracked: z.number(),
  conflicted: z.number(),
  operation: operationKindSchema.nullable(),
  /** BB environment of this project whose path is this worktree, matched by realpath. */
  environmentId: z.string().nullable(),
  /** Every known BB environment at this path, including other projects' running ones. */
  environmentIds: z.array(z.string()),
  isAnchor: z.boolean(),
  statusError: z.string().nullable(),
});
export type WorktreeInfo = z.infer<typeof worktreeInfoSchema>;

export const githubRemoteSchema = z.object({
  remote: z.string(),
  url: z.string(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
});
export type GithubRemote = z.infer<typeof githubRemoteSchema>;

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export const fileStatusSchema = z.enum(["A", "M", "D", "R", "C", "T", "U"]);
export type FileStatus = z.infer<typeof fileStatusSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: fileStatusSchema,
  similarity: z.number().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  binary: z.boolean(),
  oldBlob: z.string(),
  newBlob: z.string(),
  oldMode: z.string(),
  newMode: z.string(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const diffSnapshotSchema = z.object({
  branch: z.string(),
  parent: z.string(),
  headSha: shaSchema,
  parentSha: shaSchema,
  /** Merge base of parent and head. The diff compares base..head. */
  baseSha: shaSchema,
  /** True when the parent head is not an ancestor of the branch head. */
  diverged: z.boolean(),
});
export type DiffSnapshot = z.infer<typeof diffSnapshotSchema>;

export const uncommittedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  index: z.string(),
  worktree: z.string(),
  untracked: z.boolean(),
  conflicted: z.boolean(),
});
export type UncommittedFile = z.infer<typeof uncommittedFileSchema>;

export const patchResultSchema = z.object({
  patch: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
  binary: z.boolean(),
});
export type PatchResult = z.infer<typeof patchResultSchema>;

export const fileSidesResultSchema = z.object({
  status: z.enum(["ok", "too-large", "binary", "unavailable"]),
  old: z.object({ path: z.string(), content: z.string() }).nullable(),
  new: z.object({ path: z.string(), content: z.string() }).nullable(),
  message: z.string().nullable(),
});
export type FileSidesResult = z.infer<typeof fileSidesResultSchema>;

export const diffSideSchema = z.enum(["old", "new"]);
export type DiffSide = z.infer<typeof diffSideSchema>;

// ---------------------------------------------------------------------------
// Pull requests (optional enrichment)
// ---------------------------------------------------------------------------

export const prSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  graphiteUrl: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
});
export type PrSummary = z.infer<typeof prSummarySchema>;

export const prSourceStatusSchema = z.enum([
  "ok",
  "no-remote",
  "not-github",
  "gh-missing",
  "gh-unauthenticated",
  "error",
]);
export type PrSourceStatus = z.infer<typeof prSourceStatusSchema>;

export const prCommentSchema = z.object({
  id: z.string(),
  databaseId: z.number().nullable(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string().nullable(),
  state: z.string().nullable(),
});
export type PrComment = z.infer<typeof prCommentSchema>;

export const prThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  startLine: z.number().nullable(),
  diffSide: z.enum(["LEFT", "RIGHT"]).nullable(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  viewerCanReply: z.boolean(),
  /** More than 50 comments: only the first 50 are present. */
  commentsTruncated: z.boolean(),
  comments: z.array(prCommentSchema),
});
export type PrThread = z.infer<typeof prThreadSchema>;

export const reviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

// ---------------------------------------------------------------------------
// Graphite mutations (run through gt only)
// ---------------------------------------------------------------------------

export const gtCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("init"), trunk: branchSchema }),
  z.object({
    kind: z.literal("create"),
    name: branchSchema,
    message: z.string().trim().min(1).max(2000),
    stageAll: z.boolean(),
  }),
  z.object({ kind: z.literal("track"), branch: branchSchema, parent: branchSchema }),
  z.object({ kind: z.literal("restack-only"), branch: branchSchema }),
  z.object({ kind: z.literal("sync") }),
  z.object({
    kind: z.literal("submit"),
    branch: branchSchema,
    stack: z.boolean(),
    dryRun: z.boolean(),
  }),
  z.object({ kind: z.literal("continue") }),
  z.object({ kind: z.literal("abort") }),
]);
export type GtCommand = z.infer<typeof gtCommandSchema>;

export const commandResultSchema = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  argv: z.array(z.string()),
});
export type CommandResult = z.infer<typeof commandResultSchema>;
