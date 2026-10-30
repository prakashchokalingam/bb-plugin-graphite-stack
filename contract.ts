// Contracts for the Graphite Stack plugin.
//
// hostContract: server entry -> host entry. Each method runs git, gt, or gh
// on the host that owns the environment, with argument arrays, timeouts, and
// byte caps. The server passes an absolute `cwd` that it resolved from a BB
// environment; the host never infers a directory.
//
// rpcContract: app -> server entry. Every method takes a BB environment id
// (the anchor). The server resolves its host and path through bb.sdk.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  absolutePathSchema,
  branchNodeSchema,
  branchSchema,
  changedFileSchema,
  commandResultSchema,
  diffSideSchema,
  diffSnapshotSchema,
  fileSidesResultSchema,
  githubRemoteSchema,
  gtCommandSchema,
  patchResultSchema,
  prSourceStatusSchema,
  prSummarySchema,
  prThreadSchema,
  repoPathSchema,
  reviewEventSchema,
  shaSchema,
  uncommittedFileSchema,
  worktreeInfoSchema,
} from "./lib/model";

const cwd = absolutePathSchema;

const ghRepoInput = z.object({
  cwd,
  host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/u),
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
});

export const probeResultSchema = z.object({
  git: z.object({ available: z.boolean(), version: z.string().nullable() }),
  repo: z
    .object({
      root: z.string(),
      commonDir: z.string(),
      gitDir: z.string(),
      currentBranch: z.string().nullable(),
      headSha: z.string().nullable(),
    })
    .nullable(),
  graphite: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    /** True when the installed version is in the tested range. */
    tested: z.boolean(),
    /** `<common dir>/.graphite_repo_config` exists. */
    initialized: z.boolean(),
  }),
  gh: z.object({ available: z.boolean() }),
  error: z.string().nullable(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const readStackResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  /** "unsupported-output" when `gt state` output fails schema validation. */
  errorKind: z.enum(["gt-failed", "unsupported-output", "git-failed"]).nullable(),
  trunks: z.array(z.string()),
  branches: z.array(branchNodeSchema),
  worktrees: z.array(worktreeInfoSchema),
  anchorRealpath: z.string(),
  remote: githubRemoteSchema.nullable(),
  remoteName: z.string().nullable(),
  localBranches: z.array(z.string()),
});
export type ReadStackResult = z.infer<typeof readStackResultSchema>;

export const anchorCheckSchema = z.object({
  id: z.string(),
  path: repoPathSchema,
  side: diffSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** Exact text of the selected lines, joined with "\n". */
  text: z.string().max(256 * 1024),
});

export const worktreeStatusSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  staged: z.number(),
  unstaged: z.number(),
  untracked: z.number(),
  conflicted: z.number(),
  operation: z.enum(["rebase", "merge", "cherry-pick", "revert"]).nullable(),
});
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

export const ghWriteResultSchema = z.object({
  /** "ok": confirmed. "rejected": GitHub refused it. "unknown": no reply. */
  outcome: z.enum(["ok", "rejected", "unknown"]),
  message: z.string().nullable(),
  id: z.string().nullable(),
  url: z.string().nullable(),
});
export type GhWriteResult = z.infer<typeof ghWriteResultSchema>;

export const hostContract = defineRpcContract({
  probe: {
    input: z.object({ cwd }).strict(),
    output: probeResultSchema,
    experimental_retryable: true,
  },
  readStack: {
    input: z
      .object({
        cwd,
        environmentPaths: z.array(z.object({ id: z.string(), path: z.string() })).max(500),
        commitLimit: z.number().int().min(1).max(200),
        detailBranches: z.array(branchSchema).max(2000).optional(),
      })
      .strict(),
    output: readStackResultSchema,
    experimental_retryable: true,
  },
  topology: {
    input: z.object({ cwd }).strict(),
    output: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      errorKind: z.enum(["gt-failed", "unsupported-output", "git-failed", "uninitialized"]).nullable(),
      commonDir: z.string().nullable(),
      trunks: z.array(z.string()),
      branches: z.array(
        z.object({
          name: z.string(),
          trunk: z.boolean(),
          parent: z.string().nullable(),
          parentRecordedSha: z.string().nullable(),
          needsRestack: z.boolean(),
        }),
      ),
      remote: githubRemoteSchema.nullable(),
      remoteName: z.string().nullable(),
    }),
    experimental_retryable: true,
  },
  snapshot: {
    input: z.object({ cwd, branch: branchSchema, parent: branchSchema }).strict(),
    output: z.object({ snapshot: diffSnapshotSchema.nullable(), error: z.string().nullable() }),
    experimental_retryable: true,
  },
  worktreeStatus: {
    input: z.object({ cwd, worktreePath: absolutePathSchema }).strict(),
    output: z.object({ status: worktreeStatusSchema.nullable(), error: z.string().nullable() }),
    experimental_retryable: true,
  },
  refHeads: {
    input: z.object({ cwd, branches: z.array(branchSchema).max(500) }).strict(),
    output: z.object({ heads: z.record(z.string(), z.string().nullable()) }),
    experimental_retryable: true,
  },
  layerFiles: {
    input: z.object({ cwd, branch: branchSchema, parent: branchSchema, maxFiles: z.number().int().min(1).max(5000) }).strict(),
    output: z.object({
      snapshot: diffSnapshotSchema.nullable(),
      files: z.array(changedFileSchema),
      truncated: z.boolean(),
      error: z.string().nullable(),
    }),
    experimental_retryable: true,
  },
  filePatch: {
    input: z
      .object({
        cwd,
        baseSha: shaSchema,
        headSha: shaSchema,
        path: repoPathSchema,
        oldPath: repoPathSchema.nullable(),
        maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024),
      })
      .strict(),
    output: patchResultSchema,
    experimental_retryable: true,
  },
  fileSides: {
    input: z
      .object({
        cwd,
        baseSha: shaSchema,
        headSha: shaSchema,
        path: repoPathSchema,
        oldPath: repoPathSchema.nullable(),
        maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024),
      })
      .strict(),
    output: fileSidesResultSchema,
    experimental_retryable: true,
  },
  uncommitted: {
    input: z.object({ cwd, worktreePath: absolutePathSchema, maxFiles: z.number().int().min(1).max(5000) }).strict(),
    output: z.object({
      headSha: z.string().nullable(),
      branch: z.string().nullable(),
      files: z.array(uncommittedFileSchema),
      truncated: z.boolean(),
      error: z.string().nullable(),
    }),
    experimental_retryable: true,
  },
  uncommittedPatch: {
    input: z
      .object({
        cwd,
        worktreePath: absolutePathSchema,
        path: repoPathSchema,
        untracked: z.boolean(),
        maxBytes: z.number().int().min(1024).max(4 * 1024 * 1024),
      })
      .strict(),
    output: patchResultSchema,
    experimental_retryable: true,
  },
  readLines: {
    input: z
      .object({
        cwd,
        sha: shaSchema,
        path: repoPathSchema,
        start: z.number().int().positive(),
        end: z.number().int().positive(),
      })
      .strict(),
    output: z.object({ lines: z.array(z.string()).nullable(), error: z.string().nullable() }),
    experimental_retryable: true,
  },
  checkAnchors: {
    input: z
      .object({
        cwd,
        baseSha: shaSchema,
        headSha: shaSchema,
        anchors: z.array(anchorCheckSchema).max(500),
      })
      .strict(),
    output: z.object({
      results: z.record(z.string(), z.enum(["current", "outdated", "unknown"])),
    }),
    experimental_retryable: true,
  },
  gt: {
    input: z.object({ cwd, command: gtCommandSchema, timeoutMs: z.number().int().min(1000).max(600_000) }).strict(),
    output: commandResultSchema,
  },
  prList: {
    input: ghRepoInput.extend({ branches: z.array(z.string()).max(500) }).strict(),
    output: z.object({
      status: prSourceStatusSchema,
      message: z.string().nullable(),
      prs: z.array(prSummarySchema),
    }),
    experimental_retryable: true,
  },
  prThreads: {
    input: ghRepoInput.extend({ number: z.number().int().positive() }).strict(),
    output: z.object({
      status: prSourceStatusSchema,
      message: z.string().nullable(),
      viewer: z.string().nullable(),
      headRefOid: z.string().nullable(),
      state: z.string().nullable(),
      threads: z.array(prThreadSchema),
      truncated: z.boolean(),
    }),
    experimental_retryable: true,
  },
  prReply: {
    input: ghRepoInput
      .extend({ threadId: z.string().min(1).max(200), body: z.string().min(1).max(65_000) })
      .strict(),
    output: ghWriteResultSchema,
  },
  prSetResolved: {
    input: ghRepoInput
      .extend({ threadId: z.string().min(1).max(200), resolved: z.boolean() })
      .strict(),
    output: ghWriteResultSchema,
  },
  prSubmitReview: {
    input: ghRepoInput
      .extend({
        number: z.number().int().positive(),
        commitId: shaSchema,
        event: reviewEventSchema,
        body: z.string().max(65_000),
        comments: z
          .array(
            z.object({
              path: repoPathSchema,
              side: z.enum(["LEFT", "RIGHT"]),
              line: z.number().int().positive(),
              startLine: z.number().int().positive().nullable(),
              body: z.string().min(1).max(65_000),
            }),
          )
          .max(200),
      })
      .strict(),
    output: ghWriteResultSchema,
  },
  prFindMarker: {
    input: ghRepoInput
      .extend({
        number: z.number().int().positive(),
        marker: z.string().regex(/^bb-graphite-stack:[a-z]+:[0-9a-f-]{36}$/u),
      })
      .strict(),
    output: z.object({
      status: z.enum(["found", "not-found", "error"]),
      id: z.string().nullable(),
      url: z.string().nullable(),
      message: z.string().nullable(),
    }),
    experimental_retryable: true,
  },
  watchRepo: {
    input: z.object({ cwd, commonDir: absolutePathSchema }).strict(),
    output: z.object({ watching: z.boolean(), error: z.string().nullable() }),
  },
});
export type HostContract = typeof hostContract;

export const hostSignals = {
  repoChanged: {
    payload: z.object({ commonDir: z.string() }).strict(),
  },
} satisfies ExperimentalHostSignals;

// ---------------------------------------------------------------------------
// App -> server
// ---------------------------------------------------------------------------

export const anchorInput = z.object({ environmentId: z.string().min(1).max(200) });

export const threadSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  environmentId: z.string().nullable(),
  archived: z.boolean(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const linkStatusSchema = z.enum([
  "valid",
  "thread-missing",
  "thread-archived",
  "environment-mismatch",
  "branch-missing",
]);
export type LinkStatus = z.infer<typeof linkStatusSchema>;

export const threadLinkSchema = z.object({
  branch: z.string(),
  threadId: z.string(),
  environmentId: z.string().nullable(),
  linkedAt: z.number(),
  status: linkStatusSchema,
  thread: threadSummarySchema.nullable(),
});
export type ThreadLink = z.infer<typeof threadLinkSchema>;

export const layerViewSchema = branchNodeSchema.extend({
  children: z.array(z.string()),
  worktreePath: z.string().nullable(),
  environmentId: z.string().nullable(),
  link: threadLinkSchema.nullable(),
  /** Threads in environments that have this branch checked out. */
  candidates: z.array(threadSummarySchema),
});
export type LayerView = z.infer<typeof layerViewSchema>;

export const stackStatusSchema = z.enum([
  "ready",
  "no-environment",
  "environment-unavailable",
  "no-git",
  "no-repo",
  "no-gt",
  "gt-uninitialized",
  "gt-unsupported",
  "error",
]);
export type StackStatus = z.infer<typeof stackStatusSchema>;

export const stackViewSchema = z.object({
  status: stackStatusSchema,
  message: z.string().nullable(),
  environmentId: z.string(),
  projectId: z.string().nullable(),
  hostId: z.string().nullable(),
  repoKey: z.string().nullable(),
  repoRoot: z.string().nullable(),
  currentBranch: z.string().nullable(),
  currentTracked: z.boolean(),
  gtVersion: z.string().nullable(),
  gtTested: z.boolean(),
  ghAvailable: z.boolean(),
  trunks: z.array(z.string()),
  layers: z.array(layerViewSchema),
  worktrees: z.array(worktreeInfoSchema),
  localBranches: z.array(z.string()),
  remote: githubRemoteSchema.nullable(),
  remoteName: z.string().nullable(),
  busyRepo: z.boolean(),
  fetchedAt: z.number(),
});
export type StackView = z.infer<typeof stackViewSchema>;

export const noteAnchorSchema = z.object({
  path: repoPathSchema,
  side: diffSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
});

export const noteSchema = z.object({
  id: z.string(),
  repoKey: z.string(),
  branch: z.string(),
  path: z.string(),
  side: diffSideSchema,
  startLine: z.number(),
  endLine: z.number(),
  baseSha: z.string(),
  headSha: z.string(),
  lineText: z.string(),
  body: z.string(),
  threadId: z.string().nullable(),
  parentId: z.string().nullable(),
  resolved: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  anchorState: z.enum(["current", "outdated", "unknown"]),
  delivery: z.object({ threadId: z.string(), batchId: z.string(), status: z.enum(["sending", "sent", "queued", "unknown"]), hidden: z.boolean() }).nullable().optional(),
  replies: z.array(
    z.object({ id: z.string(), body: z.string(), createdAt: z.number() }),
  ),
});
export type Note = z.infer<typeof noteSchema>;

export const pendingCommentSchema = z.object({
  id: z.string(),
  path: z.string(),
  side: diffSideSchema,
  startLine: z.number(),
  endLine: z.number(),
  baseSha: z.string(),
  headSha: z.string(),
  body: z.string(),
  createdAt: z.number(),
  anchorState: z.enum(["current", "outdated", "unknown"]),
});
export type PendingComment = z.infer<typeof pendingCommentSchema>;

export const pendingReviewSchema = z.object({
  prNumber: z.number(),
  comments: z.array(pendingCommentSchema),
  body: z.string(),
  /** Set while a submit is in flight or its outcome is unknown. */
  submission: z
    .object({
      marker: z.string(),
      state: z.enum(["in-flight", "unknown"]),
      startedAt: z.number(),
      event: reviewEventSchema,
    })
    .nullable(),
  lastError: z.string().nullable(),
});
export type PendingReview = z.infer<typeof pendingReviewSchema>;

export const operationRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("init"), trunk: branchSchema }),
  z.object({
    kind: z.literal("create"),
    name: branchSchema,
    message: z.string().trim().min(1).max(2000),
    stageAll: z.boolean(),
  }),
  z.object({ kind: z.literal("track"), branch: branchSchema, parent: branchSchema }),
  z.object({
    kind: z.literal("restack"),
    branch: branchSchema,
    scope: z.enum(["only", "upstack", "stack"]),
  }),
  z.object({ kind: z.literal("sync") }),
  z.object({ kind: z.literal("submit"), branch: branchSchema, stack: z.boolean() }),
  z.object({
    kind: z.literal("recover"),
    worktreePath: absolutePathSchema,
    action: z.enum(["continue", "abort"]),
  }),
]);
export type OperationRequest = z.infer<typeof operationRequestSchema>;

export const stepStatusSchema = z.enum([
  "pending",
  "done",
  "up-to-date",
  "skipped-by-gt",
  "blocked",
  "conflict",
  "failed",
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const operationStepSchema = z.object({
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  environmentId: z.string().nullable(),
  argv: z.array(z.string()),
  status: stepStatusSchema,
  message: z.string().nullable(),
});
export type OperationStep = z.infer<typeof operationStepSchema>;

export const operationPreviewSchema = z.object({
  token: z.string(),
  title: z.string(),
  allowed: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  steps: z.array(operationStepSchema),
  dryRunOutput: z.string().nullable(),
});
export type OperationPreview = z.infer<typeof operationPreviewSchema>;

export const operationResultSchema = z.object({
  id: z.string(),
  outcome: z.enum(["success", "partial", "conflict", "failed", "rejected"]),
  summary: z.string(),
  steps: z.array(operationStepSchema),
  output: z.string(),
  finishedAt: z.number(),
});
export type OperationResult = z.infer<typeof operationResultSchema>;

const viewedSchema = z.object({ path: z.string(), fileKey: z.string() });

export const rpcContract = defineRpcContract({
  stack: {
    input: anchorInput.extend({ detailBranches: z.array(branchSchema).max(2000).optional() }),
    output: stackViewSchema,
  },
  projectRepos: {
    input: z.object({ projectId: z.string().min(1).max(200) }),
    output: z.object({
      repos: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          hostId: z.string(),
          environmentId: z.string(),
          environmentIds: z.array(z.string()),
          status: stackStatusSchema,
          message: z.string().nullable(),
        }),
      ),
      environmentsWithoutGit: z.number(),
    }),
  },
  prs: {
    input: anchorInput.extend({ refresh: z.boolean() }),
    output: z.object({
      status: prSourceStatusSchema,
      message: z.string().nullable(),
      fetchedAt: z.number().nullable(),
      stale: z.boolean(),
      prs: z.record(z.string(), prSummarySchema),
    }),
  },
  layerFiles: {
    input: anchorInput.extend({ branch: branchSchema }),
    output: z.object({
      snapshot: diffSnapshotSchema.nullable(),
      files: z.array(changedFileSchema),
      truncated: z.boolean(),
      error: z.string().nullable(),
      viewed: z.array(viewedSchema),
    }),
  },
  filePatch: {
    input: anchorInput.extend({
      baseSha: shaSchema,
      headSha: shaSchema,
      path: repoPathSchema,
      oldPath: repoPathSchema.nullable(),
    }),
    output: patchResultSchema,
  },
  fileSides: {
    input: anchorInput.extend({
      baseSha: shaSchema,
      headSha: shaSchema,
      path: repoPathSchema,
      oldPath: repoPathSchema.nullable(),
    }),
    output: fileSidesResultSchema,
  },
  uncommitted: {
    input: anchorInput.extend({ worktreePath: absolutePathSchema }),
    output: z.object({
      headSha: z.string().nullable(),
      branch: z.string().nullable(),
      files: z.array(uncommittedFileSchema),
      truncated: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  uncommittedPatch: {
    input: anchorInput.extend({
      worktreePath: absolutePathSchema,
      path: repoPathSchema,
      untracked: z.boolean(),
    }),
    output: patchResultSchema,
  },
  setViewed: {
    input: anchorInput.extend({
      branch: branchSchema,
      path: repoPathSchema,
      fileKey: z.string().min(1).max(200),
      viewed: z.boolean(),
    }),
    output: z.object({ viewed: z.array(viewedSchema) }),
  },
  linkThread: {
    input: anchorInput.extend({ branch: branchSchema, threadId: z.string().min(1).max(200) }),
    output: threadLinkSchema,
  },
  unlinkThread: {
    input: anchorInput.extend({ branch: branchSchema }),
    output: z.object({ removed: z.boolean() }),
  },
  notesList: {
    input: anchorInput.extend({ branch: branchSchema }),
    output: z.object({
      notes: z.array(noteSchema),
      snapshot: diffSnapshotSchema.nullable(),
      /** True when the reply size budget dropped older notes. */
      truncated: z.boolean(),
    }),
  },
  noteCreate: {
    input: anchorInput.extend({
      branch: branchSchema,
      anchor: noteAnchorSchema,
      body: z.string().trim().min(1).max(20_000),
      threadId: z.string().max(200).nullable(),
    }),
    output: noteSchema,
  },
  noteUpdate: {
    input: anchorInput.extend({ noteId: z.string().min(1).max(100), body: z.string().trim().min(1).max(20_000) }),
    output: z.object({ ok: z.boolean() }),
  },
  noteReconcile: {
    input: anchorInput.extend({ noteId: z.string().min(1).max(100) }),
    output: z.object({ status: z.enum(["sent", "unknown"]) }),
  },
  noteHide: {
    input: anchorInput.extend({ noteId: z.string().min(1).max(100), hidden: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  notesSend: {
    input: anchorInput.extend({ branch: branchSchema, threadId: z.string().min(1).max(200), noteIds: z.array(z.string().min(1).max(100)).min(1).max(100) }),
    output: z.object({ status: z.enum(["sent", "queued", "unknown"]), message: z.string().nullable() }),
  },
  noteReply: {
    input: anchorInput.extend({ noteId: z.string().min(1).max(100), body: z.string().trim().min(1).max(20_000) }),
    output: z.object({ ok: z.boolean() }),
  },
  noteSetResolved: {
    input: anchorInput.extend({ noteId: z.string().min(1).max(100), resolved: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  noteDelete: {
    input: anchorInput.extend({ noteId: z.string().min(1).max(100) }),
    output: z.object({ ok: z.boolean() }),
  },
  draftGet: {
    input: z.object({ key: z.string().min(1).max(500) }),
    output: z.object({ value: z.string().nullable() }),
  },
  draftSet: {
    input: z.object({ key: z.string().min(1).max(500), value: z.string().max(20_000).nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  prThreads: {
    input: anchorInput.extend({ branch: branchSchema }),
    output: z.object({
      status: prSourceStatusSchema,
      message: z.string().nullable(),
      pr: prSummarySchema.nullable(),
      viewer: z.string().nullable(),
      threads: z.array(prThreadSchema),
      truncated: z.boolean(),
      pending: pendingReviewSchema.nullable(),
    }),
  },
  prReply: {
    input: anchorInput.extend({
      branch: branchSchema,
      threadId: z.string().min(1).max(200),
      body: z.string().trim().min(1).max(65_000),
    }),
    output: ghWriteResultSchema,
  },
  prSetResolved: {
    input: anchorInput.extend({ branch: branchSchema, threadId: z.string().min(1).max(200), resolved: z.boolean() }),
    output: ghWriteResultSchema,
  },
  pendingAdd: {
    input: anchorInput.extend({
      branch: branchSchema,
      anchor: noteAnchorSchema,
      body: z.string().trim().min(1).max(65_000),
    }),
    output: pendingReviewSchema,
  },
  pendingRemove: {
    input: anchorInput.extend({ branch: branchSchema, commentId: z.string().min(1).max(100) }),
    output: pendingReviewSchema.nullable(),
  },
  pendingSetBody: {
    input: anchorInput.extend({ branch: branchSchema, body: z.string().max(65_000) }),
    output: pendingReviewSchema.nullable(),
  },
  submitReview: {
    input: anchorInput.extend({ branch: branchSchema, event: reviewEventSchema }),
    output: z.object({
      outcome: z.enum(["ok", "rejected", "unknown", "blocked"]),
      message: z.string().nullable(),
      url: z.string().nullable(),
      pending: pendingReviewSchema.nullable(),
    }),
  },
  reconcileReview: {
    input: anchorInput.extend({ branch: branchSchema }),
    output: z.object({
      outcome: z.enum(["posted", "not-posted", "error", "nothing"]),
      message: z.string().nullable(),
      pending: pendingReviewSchema.nullable(),
    }),
  },
  previewOperation: {
    input: anchorInput.extend({ request: operationRequestSchema }),
    output: operationPreviewSchema,
  },
  runOperation: {
    input: anchorInput.extend({ request: operationRequestSchema, token: z.string().min(1).max(200) }),
    output: operationResultSchema,
  },
  lastOperation: {
    input: anchorInput,
    output: z.object({ result: operationResultSchema.nullable() }),
  },
});
export type RpcContract = typeof rpcContract;

/** Realtime channel. Payload: `{ repoKey }`. */
export const GRAPHITE_CHANGED = "graphite-changed";
