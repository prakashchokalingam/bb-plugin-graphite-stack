// Graphite Stack: server entry.
//
// The server resolves each request's BB environment to its host and path,
// calls this plugin's host entry on that host, and keeps plugin-owned state
// (thread links, private notes, viewed files, pending reviews, operation
// journal) in the plugin database. Graphite metadata stays owned by gt.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  GRAPHITE_CHANGED,
  hostContract,
  hostSignals,
  rpcContract,
  type LayerView,
  type LinkStatus,
  type Note,
  type OperationPreview,
  type OperationRequest,
  type OperationResult,
  type OperationStep,
  type PendingReview,
  type ProbeResult,
  type ReadStackResult,
  type StackStatus,
  type StackView,
  type ThreadLink,
  type ThreadSummary,
} from "./contract";
import type { DiffSnapshot, PrSourceStatus, PrSummary } from "./lib/model";
import { planOperation, summarizeOutcome, type PlannedStep } from "./lib/operations";
import { isGtVersionSupported } from "./lib/parse";
import { createStore, MAX_NOTES_PER_BRANCH, MIGRATIONS, type Db, type NoteRow, type PendingState } from "./lib/store";

export { rpcContract } from "./contract";

const TOKEN_TTL_MS = 5 * 60_000;
const NOTES_REPLY_BUDGET = 2 * 1024 * 1024;
const PR_CACHE_FRESH_MS = 60_000;
const GT_TIMEOUT_MS = 5 * 60_000;
const BUSY_STATUSES = new Set(["active", "starting", "pending", "stopping", "provisioning"]);

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
/** The thread fields the plugin reads; `threads.get` and `threads.list` rows both satisfy it. */
type Thread = Pick<
  Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
  "id" | "title" | "titleFallback" | "runtime" | "status" | "environmentId" | "archivedAt" | "deletedAt" | "projectId"
>;

interface Anchor {
  environment: Environment;
  hostId: string;
  cwd: string;
  projectId: string;
}

interface RepoContext extends Anchor {
  probe: ProbeResult;
  commonDir: string;
  repoKey: string;
}

class UserError extends Error {}

export function repoKeyFor(hostId: string, commonDir: string): string {
  return createHash("sha256").update(`${hostId}\0${commonDir}`).digest("hex").slice(0, 24);
}

function threadTitle(thread: Thread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function summarizeThread(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    title: threadTitle(thread),
    status: thread.runtime.displayStatus,
    environmentId: thread.environmentId,
    archived: thread.archivedAt !== null,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    patchLimitKb: {
      type: "number",
      label: "Largest patch to load (KB)",
      experimental_schema: z.number().int().min(16).max(4096),
      default: 1024,
    },
    commitLimit: {
      type: "number",
      label: "Commits to list per branch",
      experimental_schema: z.number().int().min(1).max(200),
      default: 50,
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const db = bb.storage.database() as unknown as Db;
  bb.storage.migrate(db as never, MIGRATIONS);
  const store = createStore(db);

  /** commonDir (per host) -> repoKey, for host signals. */
  const repoKeysByCommonDir = new Map<string, string>();
  const watchedRepos = new Set<string>();
  const locks = new Set<string>();
  /** repoKey + branch: one review write at a time, from first read to final state. */
  const reviewLocks = new Set<string>();
  async function withReviewLock<T>(repoKey: string, branch: string, fn: () => Promise<T>): Promise<T> {
    const key = `${repoKey}\0${branch}`;
    if (reviewLocks.has(key)) throw new UserError("A review action is already running for this branch. Wait for it to finish.");
    reviewLocks.add(key);
    try {
      return await fn();
    } finally {
      reviewLocks.delete(key);
    }
  }
  const tokens = new Map<
    string,
    { environmentId: string; request: string; heads: Record<string, string | null>; createdAt: number; repoKey: string }
  >();
  const prCache = new Map<
    string,
    { fetchedAt: number; prs: Record<string, PrSummary>; status: PrSourceStatus; message: string | null }
  >();
  const worktreeCache = new Map<string, { at: number; paths: Set<string> }>();

  const publish = (repoKey: string) => bb.realtime.publish(GRAPHITE_CHANGED, { repoKey });

  const unsubscribeSignal = host.experimental_onSignal("repoChanged", ({ hostId, payload }) => {
    const repoKey = repoKeysByCommonDir.get(`${hostId}\0${payload.commonDir}`);
    if (repoKey !== undefined) {
      worktreeCache.delete(repoKey);
      publish(repoKey);
    }
  });
  const unsubscribeExit = host.experimental_onWorkerExit(({ hostId }) => {
    // Watches died with the worker; the next stack read starts them again.
    for (const key of [...watchedRepos]) if (key.startsWith(`${hostId}\0`)) watchedRepos.delete(key);
  });
  bb.onDispose(() => {
    unsubscribeSignal();
    unsubscribeExit();
  });

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  async function resolveAnchor(environmentId: string): Promise<Anchor | { status: StackStatus; message: string }> {
    let environment: Environment;
    try {
      environment = await bb.sdk.environments.get({ environmentId });
    } catch {
      return { status: "no-environment", message: "This environment does not exist." };
    }
    if (environment.lifecycle.phase !== "active" || environment.hostLifecycle !== "active" || environment.status === "destroyed") {
      return { status: "no-environment", message: "This environment is retired." };
    }
    if (environment.status !== "ready" || environment.path === null) {
      return { status: "environment-unavailable", message: `The environment is ${environment.status}.` };
    }
    return { environment, hostId: environment.hostId, cwd: environment.path, projectId: environment.projectId };
  }

  async function probeAt(hostId: string, cwd: string): Promise<ProbeResult> {
    return host.call("probe", { cwd }, { hostId, timeoutMs: 45_000 });
  }

  async function requireRepo(environmentId: string): Promise<RepoContext> {
    const anchor = await resolveAnchor(environmentId);
    if (!("environment" in anchor)) throw new UserError(anchor.message);
    const probe = await probeAt(anchor.hostId, anchor.cwd);
    if (probe.repo === null) throw new UserError(probe.error ?? "This environment is not a Git repository.");
    const repoKey = repoKeyFor(anchor.hostId, probe.repo.commonDir);
    repoKeysByCommonDir.set(`${anchor.hostId}\0${probe.repo.commonDir}`, repoKey);
    return { ...anchor, probe, commonDir: probe.repo.commonDir, repoKey };
  }

  async function topologyOf(ctx: RepoContext) {
    const topology = await host.call("topology", { cwd: ctx.cwd }, { hostId: ctx.hostId, timeoutMs: 45_000 });
    if (!topology.ok) throw new UserError(topology.error ?? "Graphite topology is unavailable.");
    return topology;
  }

  async function parentOf(ctx: RepoContext, branch: string) {
    const topology = await topologyOf(ctx);
    const node = topology.branches.find((candidate) => candidate.name === branch);
    if (node === undefined) throw new UserError(`${branch} is not tracked by Graphite.`);
    if (node.trunk || node.parent === null) throw new UserError(`${branch} is a trunk branch; it has no parent layer.`);
    return { topology, parent: node.parent };
  }

  async function currentSnapshot(ctx: RepoContext, branch: string): Promise<DiffSnapshot> {
    const { parent } = await parentOf(ctx, branch);
    const result = await host.call("snapshot", { cwd: ctx.cwd, branch, parent }, { hostId: ctx.hostId });
    if (result.snapshot === null) throw new UserError(result.error ?? "Snapshot is unavailable.");
    return result.snapshot;
  }

  async function projectEnvironments(projectId: string, hostId?: string) {
    const environments = await bb.sdk.environments.list({ projectId, ...(hostId ? { hostId } : {}), limit: 500 });
    return environments.filter(
      (environment) =>
        environment.path !== null && environment.status === "ready" && environment.lifecycle.phase === "active",
    );
  }

  async function projectThreads(projectId: string): Promise<Thread[]> {
    try {
      return await bb.sdk.threads.list({ projectId, limit: 500 });
    } catch {
      return [];
    }
  }

  async function readStackFor(
    ctx: RepoContext,
    extraEnvironments: readonly { id: string; path: string }[] = [],
    commitLimitOverride?: number,
    detailBranches?: string[],
  ): Promise<ReadStackResult> {
    const environments = await projectEnvironments(ctx.projectId, ctx.hostId);
    const { commitLimit } = await settings.get();
    const environmentPaths = [
      ...environments.map((environment) => ({ id: environment.id, path: environment.path! })),
      ...extraEnvironments,
    ].slice(0, 500);
    const result = await host.call(
      "readStack",
      {
        cwd: ctx.cwd,
        environmentPaths,
        commitLimit: commitLimitOverride ?? Math.min(200, Math.max(1, Math.floor(commitLimit))),
        ...(detailBranches === undefined ? {} : { detailBranches }),
      },
      { hostId: ctx.hostId, timeoutMs: 120_000 },
    );
    if (result.ok) {
      worktreeCache.set(ctx.repoKey, { at: Date.now(), paths: new Set(result.worktrees.map((worktree) => worktree.path)) });
    }
    return result;
  }

  async function requireWorktree(ctx: RepoContext, worktreePath: string) {
    const cached = worktreeCache.get(ctx.repoKey);
    if (cached !== undefined && Date.now() - cached.at < 60_000 && cached.paths.has(worktreePath)) return;
    const stack = await readStackFor(ctx);
    if (!stack.worktrees.some((worktree) => worktree.path === worktreePath)) {
      throw new UserError("That path is not a worktree of this repository.");
    }
  }

  /**
   * Running agents on this host, from every project, with their environment
   * paths. Mutation guards use this read; a failure rejects the mutation.
   */
  async function runningEnvironments(hostId: string): Promise<{ environments: { id: string; path: string }[]; busy: Map<string, string[]> }> {
    let running;
    try {
      running = await bb.sdk.threads.listRunning();
    } catch (error) {
      throw new UserError(`Active agent state is unavailable (${message(error)}). The action is blocked.`);
    }
    const busy = new Map<string, string[]>();
    const environments = new Map<string, string>();
    const candidates = running.filter((entry) => entry.hostId === null || entry.hostId === hostId).slice(0, 200);
    await Promise.all(
      candidates.map(async (entry) => {
        let thread: Thread;
        try {
          thread = await bb.sdk.threads.get({ threadId: entry.id });
        } catch (error) {
          throw new UserError(`Active agent state is unavailable (${message(error)}). The action is blocked.`);
        }
        if (thread.environmentId === null) return;
        const list = busy.get(thread.environmentId) ?? [];
        list.push(threadTitle(thread));
        busy.set(thread.environmentId, list);
        if (!environments.has(thread.environmentId)) {
          try {
            const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
            if (environment.hostId === hostId && environment.path !== null) environments.set(environment.id, environment.path);
          } catch (error) {
            throw new UserError(`Active agent state is unavailable (${message(error)}). The action is blocked.`);
          }
        }
      }),
    );
    return { environments: [...environments].map(([id, path]) => ({ id, path })), busy };
  }

  function ensureWatch(ctx: RepoContext) {
    const key = `${ctx.hostId}\0${ctx.commonDir}`;
    if (watchedRepos.has(key)) return;
    watchedRepos.add(key);
    host.call("watchRepo", { cwd: ctx.cwd, commonDir: ctx.commonDir }, { hostId: ctx.hostId }).then(
      (result) => {
        if (!result.watching) watchedRepos.delete(key);
      },
      () => watchedRepos.delete(key),
    );
  }

  // -------------------------------------------------------------------------
  // Stack view
  // -------------------------------------------------------------------------

  function emptyView(environmentId: string, status: StackStatus, message: string | null, extra: Partial<StackView> = {}): StackView {
    return {
      status,
      message,
      environmentId,
      projectId: null,
      hostId: null,
      repoKey: null,
      repoRoot: null,
      currentBranch: null,
      currentTracked: false,
      gtVersion: null,
      gtTested: false,
      ghAvailable: false,
      trunks: [],
      layers: [],
      worktrees: [],
      localBranches: [],
      remote: null,
      remoteName: null,
      busyRepo: false,
      fetchedAt: Date.now(),
      ...extra,
    };
  }

  async function linkFor(
    repoKey: string,
    branch: string,
    known: { tracked: Set<string>; local: Set<string>; repoEnvironmentIds: Set<string> },
    threadCache: Map<string, Thread | null>,
  ): Promise<ThreadLink | null> {
    const row = store.getLink(repoKey, branch);
    if (row === null) return null;
    let thread = threadCache.get(row.threadId);
    if (thread === undefined) {
      try {
        thread = await bb.sdk.threads.get({ threadId: row.threadId });
      } catch {
        thread = null;
      }
      threadCache.set(row.threadId, thread);
    }
    let status: LinkStatus = "valid";
    if (thread === null || thread.deletedAt !== null) status = "thread-missing";
    else if (thread.archivedAt !== null) status = "thread-archived";
    else if (thread.environmentId === null || !known.repoEnvironmentIds.has(thread.environmentId)) status = "environment-mismatch";
    else if (!known.tracked.has(branch) && !known.local.has(branch)) status = "branch-missing";
    return {
      branch,
      threadId: row.threadId,
      environmentId: row.environmentId,
      linkedAt: row.linkedAt,
      status,
      thread: thread === null || thread.deletedAt !== null ? null : summarizeThread(thread),
    };
  }

  async function buildStack(environmentId: string, detailBranches?: string[]): Promise<StackView> {
    const anchor = await resolveAnchor(environmentId);
    if (!("environment" in anchor)) return emptyView(environmentId, anchor.status, anchor.message);
    const base = { projectId: anchor.projectId, hostId: anchor.hostId };
    let probe: ProbeResult;
    try {
      probe = await probeAt(anchor.hostId, anchor.cwd);
    } catch (error) {
      return emptyView(environmentId, "environment-unavailable", `The host is unreachable: ${message(error)}`, base);
    }
    if (!probe.git.available) return emptyView(environmentId, "no-git", "git is not installed on this host.", base);
    if (probe.repo === null) {
      return emptyView(environmentId, "no-repo", "This environment is not a Git repository.", base);
    }
    const repoKey = repoKeyFor(anchor.hostId, probe.repo.commonDir);
    repoKeysByCommonDir.set(`${anchor.hostId}\0${probe.repo.commonDir}`, repoKey);
    const common = {
      ...base,
      repoKey,
      repoRoot: probe.repo.root,
      currentBranch: probe.repo.currentBranch,
      gtVersion: probe.graphite.version,
      gtTested: probe.graphite.tested,
      ghAvailable: probe.gh.available,
      busyRepo: locks.has(repoKey),
    };
    if (!probe.graphite.available) {
      return emptyView(environmentId, "no-gt", "The Graphite CLI (gt) is not installed on this host.", common);
    }
    if (!isGtVersionSupported(probe.graphite.version)) {
      return emptyView(environmentId, "gt-unsupported", `gt ${probe.graphite.version ?? "unknown"} is not supported. Use gt 1.8 or later 1.x.`, common);
    }
    if (!probe.graphite.initialized) {
      return emptyView(environmentId, "gt-uninitialized", "Graphite is not initialized in this repository.", common);
    }
    const ctx: RepoContext = { ...anchor, probe, commonDir: probe.repo.commonDir, repoKey };
    ensureWatch(ctx);
    const [stack, threads] = await Promise.all([readStackFor(ctx, [], undefined, detailBranches), projectThreads(anchor.projectId)]);
    if (!stack.ok) {
      return emptyView(
        environmentId,
        stack.errorKind === "unsupported-output" ? "gt-unsupported" : "error",
        stack.error,
        common,
      );
    }
    const children = new Map<string, string[]>();
    for (const branch of stack.branches) children.set(branch.name, []);
    for (const branch of stack.branches) if (branch.parent !== null) children.get(branch.parent)?.push(branch.name);
    const tracked = new Set(stack.branches.map((branch) => branch.name));
    const local = new Set([...stack.localBranches, ...stack.branches.filter((branch) => branch.headSha !== null).map((branch) => branch.name)]);
    const repoEnvironmentIds = new Set(stack.worktrees.map((worktree) => worktree.environmentId).filter((id): id is string => id !== null));
    const threadCache = new Map<string, Thread | null>(threads.map((thread) => [thread.id, thread]));
    const layers: LayerView[] = [];
    for (const branch of stack.branches) {
      const worktree = stack.worktrees.find((candidate) => candidate.branch === branch.name) ?? null;
      const candidates =
        worktree?.environmentId === null || worktree === null
          ? []
          : threads
              .filter((thread) => thread.environmentId === worktree.environmentId && thread.archivedAt === null)
              .slice(0, 10)
              .map(summarizeThread);
      layers.push({
        ...branch,
        children: (children.get(branch.name) ?? []).sort(),
        worktreePath: worktree?.path ?? null,
        environmentId: worktree?.environmentId ?? null,
        link: await linkFor(repoKey, branch.name, { tracked, local, repoEnvironmentIds }, threadCache),
        candidates,
      });
    }
    return {
      ...emptyView(environmentId, "ready", null, common),
      currentTracked: probe.repo.currentBranch !== null && tracked.has(probe.repo.currentBranch),
      trunks: stack.trunks,
      layers,
      worktrees: stack.worktrees,
      localBranches: stack.localBranches,
      remote: stack.remote,
      remoteName: stack.remoteName,
    };
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  async function loadPrs(ctx: RepoContext, refresh: boolean) {
    const topology = await topologyOf(ctx);
    if (topology.remoteName === null) {
      return { status: "no-remote" as const, message: "This repository has no Git remote. Local stack data is complete.", fetchedAt: null, stale: false, prs: {} };
    }
    if (topology.remote === null) {
      return { status: "not-github" as const, message: "The remote is not a GitHub repository.", fetchedAt: null, stale: false, prs: {} };
    }
    let cached = prCache.get(ctx.repoKey);
    if (cached === undefined) {
      const persisted = await bb.storage.kv.get<{ fetchedAt: number; prs: Record<string, PrSummary> }>(`prcache:${ctx.repoKey}`);
      if (persisted !== null && persisted !== undefined) {
        cached = { ...persisted, status: "ok", message: null };
        prCache.set(ctx.repoKey, cached);
      }
    }
    if (!refresh && cached !== undefined && cached.status === "ok" && Date.now() - cached.fetchedAt < PR_CACHE_FRESH_MS) {
      return { status: cached.status, message: cached.message, fetchedAt: cached.fetchedAt, stale: false, prs: cached.prs };
    }
    const branches = topology.branches.filter((branch) => !branch.trunk).map((branch) => branch.name);
    let result;
    try {
      result = await host.call(
        "prList",
        { cwd: ctx.cwd, host: topology.remote.host, owner: topology.remote.owner, repo: topology.remote.repo, branches },
        { hostId: ctx.hostId, timeoutMs: 90_000 },
      );
    } catch (error) {
      result = { status: "error" as const, message: message(error), prs: [] };
    }
    if (result.status !== "ok") {
      // Keep the last good PR data; local data never depends on it.
      return {
        status: result.status,
        message: result.message,
        fetchedAt: cached?.fetchedAt ?? null,
        stale: cached !== undefined,
        prs: cached?.prs ?? {},
      };
    }
    const prs: Record<string, PrSummary> = {};
    for (const pr of result.prs) prs[pr.headRefName] = pr;
    const entry = { fetchedAt: Date.now(), prs, status: "ok" as const, message: null };
    prCache.set(ctx.repoKey, entry);
    const serialized = JSON.stringify({ fetchedAt: entry.fetchedAt, prs });
    if (serialized.length < 200_000) await bb.storage.kv.set(`prcache:${ctx.repoKey}`, { fetchedAt: entry.fetchedAt, prs });
    return { status: "ok" as const, message: null, fetchedAt: entry.fetchedAt, stale: false, prs };
  }

  async function prForBranch(ctx: RepoContext, branch: string) {
    const topology = await topologyOf(ctx);
    if (topology.remote === null) {
      return { remote: null, pr: null, status: (topology.remoteName === null ? "no-remote" : "not-github") as PrSourceStatus, message: topology.remoteName === null ? "No Git remote. PR actions are off; private notes still work." : "The remote is not on GitHub. PR actions are off." };
    }
    const result = await host.call(
      "prList",
      { cwd: ctx.cwd, host: topology.remote.host, owner: topology.remote.owner, repo: topology.remote.repo, branches: [branch] },
      { hostId: ctx.hostId, timeoutMs: 60_000 },
    );
    if (result.status !== "ok") return { remote: topology.remote, pr: null, status: result.status, message: result.message };
    const pr = result.prs.find((candidate) => candidate.headRefName === branch) ?? null;
    return {
      remote: topology.remote,
      pr,
      status: "ok" as PrSourceStatus,
      message: pr === null ? "This branch has no pull request. Submit it to open one; private notes still work." : null,
    };
  }

  // -------------------------------------------------------------------------
  // Notes and pending reviews
  // -------------------------------------------------------------------------

  async function anchorLineText(ctx: RepoContext, branch: string, anchor: { path: string; side: "old" | "new"; startLine: number; endLine: number; baseSha: string; headSha: string }) {
    if (anchor.endLine < anchor.startLine || anchor.endLine - anchor.startLine > 500) throw new UserError("Invalid line range.");
    const snapshot = await currentSnapshot(ctx, branch);
    if (snapshot.headSha !== anchor.headSha || snapshot.baseSha !== anchor.baseSha) {
      throw new UserError("Snapshot is stale; refresh the layer and select the line again.");
    }
    const sha = anchor.side === "new" ? anchor.headSha : anchor.baseSha;
    const lines = await host.call(
      "readLines",
      { cwd: ctx.cwd, sha, path: anchor.path, start: anchor.startLine, end: anchor.endLine },
      { hostId: ctx.hostId },
    );
    if (lines.lines === null) throw new UserError(lines.error ?? "That line does not exist on this side.");
    // The anchor keeps the full selected text, so a change anywhere in the range makes it outdated.
    const lineText = lines.lines.join("\n");
    if (lineText.length > 256 * 1024) throw new UserError("The selected range is too large.");
    return { snapshot, lineText };
  }

  async function anchorStates(
    ctx: RepoContext,
    snapshot: DiffSnapshot | null,
    anchors: readonly { id: string; path: string; side: "old" | "new"; startLine: number; endLine: number; lineText: string }[],
  ): Promise<Record<string, "current" | "outdated" | "unknown">> {
    if (snapshot === null || anchors.length === 0) return {};
    try {
      const result = await host.call(
        "checkAnchors",
        {
          cwd: ctx.cwd,
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
          anchors: anchors.slice(0, 500).map((anchor) => ({
            id: anchor.id,
            path: anchor.path,
            side: anchor.side,
            startLine: anchor.startLine,
            endLine: anchor.endLine,
            text: anchor.lineText,
          })),
        },
        { hostId: ctx.hostId, timeoutMs: 60_000 },
      );
      return result.results;
    } catch {
      return {};
    }
  }

  function noteView(row: NoteRow, replies: NoteRow[], state: "current" | "outdated" | "unknown"): Note {
    return {
      ...row,
      anchorState: state,
      delivery: store.getNoteDelivery(row.id),
      replies: replies.map((reply) => ({ id: reply.id, body: reply.body, createdAt: reply.createdAt })),
    };
  }

  async function pendingView(ctx: RepoContext, branch: string, state: PendingState | null, snapshot: DiffSnapshot | null): Promise<PendingReview | null> {
    if (state === null) return null;
    const anchors = await anchorStates(
      ctx,
      snapshot,
      state.comments.map((comment) => ({ id: comment.id, path: comment.path, side: comment.side, startLine: comment.startLine, endLine: comment.endLine, lineText: comment.lineText })),
    );
    let submission = state.submission;
    // An in-flight submit from an earlier server process has an unknown outcome.
    if (submission !== null && submission.state === "in-flight" && Date.now() - submission.startedAt > 120_000) {
      submission = { ...submission, state: "unknown" };
    }
    return {
      prNumber: state.prNumber,
      body: state.body,
      submission,
      lastError: state.lastError,
      comments: state.comments.map((comment) => ({
        id: comment.id,
        path: comment.path,
        side: comment.side,
        startLine: comment.startLine,
        endLine: comment.endLine,
        baseSha: comment.baseSha,
        headSha: comment.headSha,
        body: comment.body,
        createdAt: comment.createdAt,
        anchorState:
          snapshot !== null && (comment.headSha !== snapshot.headSha || comment.baseSha !== snapshot.baseSha)
            ? (anchors[comment.id] ?? "unknown") === "current"
              ? "outdated"
              : (anchors[comment.id] ?? "unknown")
            : (anchors[comment.id] ?? "unknown"),
      })),
    };
  }

  async function safeSnapshot(ctx: RepoContext, branch: string): Promise<DiffSnapshot | null> {
    try {
      return await currentSnapshot(ctx, branch);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async function planFor(ctx: RepoContext, request: OperationRequest) {
    const running = await runningEnvironments(ctx.hostId);
    const stack = ctx.probe.graphite.initialized ? await readStackFor(ctx, running.environments) : null;
    if (stack !== null && !stack.ok) throw new UserError(stack.error ?? "The stack could not be read.");
    let worktrees = stack?.worktrees ?? [];
    let localBranches = new Set([...(stack?.localBranches ?? []), ...(stack?.branches.filter((branch) => branch.headSha !== null).map((branch) => branch.name) ?? [])]);
    if (stack === null) {
      // Uninitialized: read the anchor worktree and its branches without gt.
      const status = await host.call("worktreeStatus", { cwd: ctx.cwd, worktreePath: ctx.cwd }, { hostId: ctx.hostId });
      if (status.status === null) throw new UserError(status.error ?? "Worktree status is unavailable.");
      const environments = await projectEnvironments(ctx.projectId, ctx.hostId);
      worktrees = [
        {
          ...status.status,
          detached: status.status.branch === null,
          bare: false,
          environmentId: environments.find((environment) => environment.id === ctx.environment.id)?.id ?? null,
          environmentIds: [ctx.environment.id, ...running.environments.filter((environment) => environment.path === ctx.cwd).map((environment) => environment.id)],
          isAnchor: true,
          statusError: status.error,
        },
      ];
      if (request.kind === "init") {
        const heads = await host.call("refHeads", { cwd: ctx.cwd, branches: [request.trunk] }, { hostId: ctx.hostId });
        localBranches = new Set(Object.entries(heads.heads).filter(([, sha]) => sha !== null).map(([name]) => name));
      }
    }
    const anchorPath = worktrees.find((worktree) => worktree.isAnchor)?.path ?? stack?.anchorRealpath ?? ctx.cwd;
    const plan = planOperation({
      request,
      initialized: ctx.probe.graphite.initialized,
      trunks: stack?.trunks ?? [],
      branches: stack?.branches ?? [],
      localBranches,
      worktrees,
      anchorPath,
      busy: running.busy,
      hasRemote: (stack?.remoteName ?? null) !== null,
      hasGithubRemote: (stack?.remote ?? null) !== null,
    });
    return { plan, stack };
  }

  async function headsOf(ctx: RepoContext, branches: readonly string[]) {
    if (branches.length === 0) return {};
    const result = await host.call("refHeads", { cwd: ctx.cwd, branches: [...new Set(branches)].slice(0, 500) }, { hostId: ctx.hostId });
    return result.heads;
  }

  function publicStep(step: PlannedStep): OperationStep {
    return {
      branch: step.branch,
      worktreePath: step.worktreePath,
      environmentId: step.environmentId,
      argv: step.argv,
      status: step.status,
      message: step.message,
    };
  }

  async function runGt(ctx: RepoContext, step: PlannedStep) {
    try {
      return await host.call(
        "gt",
        { cwd: step.cwd, command: step.command, timeoutMs: GT_TIMEOUT_MS },
        { hostId: ctx.hostId, timeoutMs: GT_TIMEOUT_MS + 60_000 },
      );
    } catch (error) {
      // The host call failed without a result: the command can still have run.
      return { exitCode: null, stdout: "", stderr: message(error), timedOut: true, truncated: false, argv: step.argv };
    }
  }

  function outputOf(result: { stdout: string; stderr: string }): string {
    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  }

  async function executePlan(
    ctx: RepoContext,
    request: OperationRequest,
    steps: PlannedStep[],
    affectedBranches: readonly string[],
  ): Promise<{ steps: OperationStep[]; output: string[] }> {
    const output: string[] = [];
    const statusOf = async (worktreePath: string) =>
      host.call("worktreeStatus", { cwd: ctx.cwd, worktreePath }, { hostId: ctx.hostId });

    if (request.kind === "restack") {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        const topology = await topologyOf(ctx);
        const node = topology.branches.find((branch) => branch.name === step.branch);
        if (node === undefined) {
          step.status = "failed";
          step.message = "The branch is no longer tracked";
          break;
        }
        if (!node.needsRestack) {
          step.status = "up-to-date";
          step.message = "Already on its parent";
          continue;
        }
        const before = await statusOf(step.cwd);
        if (before.status === null || before.error !== null) {
          step.status = "blocked";
          step.message = `Worktree status is unknown: ${before.error ?? "no status"}`;
          break;
        }
        const dirty = before.status.staged + before.status.unstaged + before.status.conflicted;
        if (dirty > 0 || before.status.operation !== null) {
          step.status = "blocked";
          step.message = before.status.operation !== null ? `A ${before.status.operation} is in progress` : "The worktree has uncommitted changes";
          break;
        }
        // An agent can start between steps; check the executing worktree again.
        const running = await runningEnvironments(ctx.hostId);
        const latest = await readStackFor(ctx, running.environments, 1);
        const executor = latest.worktrees.find((worktree) => worktree.path === step.worktreePath);
        const activeTitles = (executor?.environmentIds ?? []).flatMap((id) => running.busy.get(id) ?? []);
        if (!latest.ok || executor === undefined || activeTitles.length > 0) {
          step.status = "blocked";
          step.message = activeTitles.length > 0 ? `Agent is active in ${activeTitles.join(", ")}` : "The worktree is no longer available";
          break;
        }
        const result = await runGt(ctx, step);
        output.push(`$ ${step.argv.join(" ")}\n${outputOf(result)}`);
        const after = await statusOf(step.cwd);
        if (after.status?.operation === "rebase") {
          step.status = "conflict";
          step.message = `Conflict in ${step.worktreePath}. Resolve it, then Continue or Abort.`;
          break;
        }
        if (result.timedOut || result.exitCode === null) {
          step.status = "failed";
          step.message = "The command did not finish. Its outcome is unknown; inspect the worktree.";
          break;
        }
        if (result.exitCode !== 0) {
          step.status = "failed";
          step.message = outputOf(result).split("\n").find(Boolean) ?? `gt exited with ${result.exitCode}`;
          break;
        }
        const check = await topologyOf(ctx);
        if (check.branches.find((branch) => branch.name === step.branch)?.needsRestack) {
          step.status = "skipped-by-gt";
          step.message = outputOf(result).split("\n").find((line) => /did not restack/iu.test(line)) ?? "gt left the branch unrestacked";
          break;
        }
        step.status = "done";
        step.message = `Restacked on ${node.parent}`;
      }
      return { steps: steps.map(publicStep), output };
    }

    const [step] = steps;
    if (step === undefined) return { steps: [], output };
    const before = request.kind === "sync" || request.kind === "submit" ? await topologyOf(ctx).catch(() => null) : null;
    const result = await runGt(ctx, step);
    output.push(`$ ${step.argv.join(" ")}\n${outputOf(result)}`);
    const unknown = result.timedOut || result.exitCode === null;
    const firstLine = outputOf(result).split("\n").find(Boolean) ?? null;
    const extra: OperationStep[] = [];

    switch (request.kind) {
      case "init": {
        const probe = await probeAt(ctx.hostId, ctx.cwd);
        step.status = probe.graphite.initialized && !unknown && result.exitCode === 0 ? "done" : "failed";
        step.message = step.status === "done" ? "Graphite is initialized" : (firstLine ?? "gt init failed");
        break;
      }
      case "create":
      case "track": {
        const topology = await topologyOf(ctx).catch(() => null);
        const name = request.kind === "create" ? request.name : request.branch;
        const node = topology?.branches.find((branch) => branch.name === name);
        const ok = !unknown && result.exitCode === 0 && node !== undefined && (request.kind === "create" || node.parent === request.parent);
        step.status = ok ? "done" : "failed";
        step.message = ok ? `${name} is tracked on ${node!.parent}` : unknown ? "The command did not finish; outcome unknown" : (firstLine ?? "gt failed");
        break;
      }
      case "recover": {
        const after = await statusOf(step.cwd);
        if (after.status?.operation === "rebase") {
          step.status = "conflict";
          step.message = "The rebase is still in progress. Resolve the conflict, then Continue again.";
        } else {
          step.status = !unknown && result.exitCode === 0 ? "done" : "failed";
          step.message = step.status === "done" ? (request.action === "continue" ? "Continued" : "Aborted") : (firstLine ?? "gt failed");
        }
        break;
      }
      case "sync": {
        step.status = !unknown && result.exitCode === 0 ? "done" : "failed";
        step.message = step.status === "done" ? "gt sync finished" : (firstLine ?? "gt sync failed");
        const after = await topologyOf(ctx).catch(() => null);
        const heads = await headsOf(ctx, (before?.branches ?? []).map((branch) => branch.name)).catch(() => ({}) as Record<string, string | null>);
        for (const branch of before?.branches ?? []) {
          if (branch.trunk) continue;
          const now = after?.branches.find((candidate) => candidate.name === branch.name);
          extra.push({
            branch: branch.name,
            worktreePath: null,
            environmentId: null,
            argv: [],
            status: now === undefined ? (heads[branch.name] === null ? "done" : "failed") : now.needsRestack ? "skipped-by-gt" : "up-to-date",
            message:
              now === undefined
                ? heads[branch.name] === null
                  ? "Deleted by gt sync"
                  : "No longer tracked"
                : now.needsRestack
                  ? "Still needs a restack (gt skips conflicts and branches in other worktrees)"
                  : "On its parent",
          });
        }
        break;
      }
      case "submit": {
        step.status = !unknown && result.exitCode === 0 ? "done" : "failed";
        step.message = step.status === "done" ? "gt submit finished" : unknown ? "The command did not finish; outcome unknown" : (firstLine ?? "gt submit failed");
        // Confirm each branch independently: a PR at the local head.
        const affected = affectedBranches;
        const heads = await headsOf(ctx, affected).catch(() => ({}) as Record<string, string | null>);
        const prs = await loadPrs(ctx, true).catch(() => null);
        for (const name of affected) {
          const pr = prs?.prs[name];
          const confirmed = pr !== undefined && pr.headRefOid === heads[name];
          extra.push({
            branch: name,
            worktreePath: null,
            environmentId: null,
            argv: [],
            status: confirmed ? "done" : prs === null || prs.status !== "ok" ? "pending" : "failed",
            message: confirmed
              ? `PR #${pr!.number}${pr!.isDraft ? " (draft)" : ""} is at the local head`
              : prs === null || prs.status !== "ok"
                ? `Not confirmed: ${prs?.message ?? "PR read failed"}`
                : "No PR at the local head after submit",
          });
        }
        break;
      }
      default:
        break;
    }
    return { steps: [...steps.map(publicStep), ...extra], output };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UserError) throw new Error(error.message);
      throw error;
    }
  }

  function ownNote(ctx: RepoContext, noteId: string): NoteRow {
    const note = store.getNote(noteId);
    if (note === null || note.repoKey !== ctx.repoKey) throw new UserError("Note not found.");
    return note;
  }

  async function validateThreadForRepo(ctx: RepoContext, threadId: string): Promise<Thread> {
    let thread: Thread;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      throw new UserError("Thread not found.");
    }
    if (thread.deletedAt !== null) throw new UserError("Thread not found.");
    if (thread.archivedAt !== null) throw new UserError("The thread is archived. Unarchive it or pick another thread.");
    if (thread.projectId !== ctx.projectId) throw new UserError("The thread belongs to another project.");
    if (thread.environmentId === null) throw new UserError("The thread has no environment.");
    if (thread.environmentId !== ctx.environment.id) {
      let environment: Environment;
      try {
        environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      } catch {
        throw new UserError("The thread's environment does not exist.");
      }
      if (environment.hostId !== ctx.hostId || environment.path === null) {
        throw new UserError("The thread works on another machine.");
      }
      const probe = await probeAt(environment.hostId, environment.path);
      if (probe.repo?.commonDir !== ctx.commonDir) throw new UserError("The thread works in another repository.");
    }
    return thread;
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    stack: ({ environmentId, detailBranches }) => buildStack(environmentId, detailBranches),

    projectRepos: async ({ projectId }) => {
      const environments = await projectEnvironments(projectId);
      const groups = new Map<
        string,
        { key: string; label: string; hostId: string; environmentIds: string[]; preferred: string | null; mainRoot: string; status: StackStatus; message: string | null }
      >();
      let withoutGit = 0;
      const probes = await Promise.all(
        environments.slice(0, 100).map(async (environment) => {
          try {
            return { environment, probe: await probeAt(environment.hostId, environment.path!) };
          } catch {
            return { environment, probe: null };
          }
        }),
      );
      for (const { environment, probe } of probes) {
        if (probe === null || probe.repo === null) {
          withoutGit += 1;
          continue;
        }
        const key = repoKeyFor(environment.hostId, probe.repo.commonDir);
        const mainRoot = path.basename(probe.repo.commonDir) === ".git" ? path.dirname(probe.repo.commonDir) : probe.repo.commonDir;
        const status: StackStatus = !probe.graphite.available
          ? "no-gt"
          : !isGtVersionSupported(probe.graphite.version)
            ? "gt-unsupported"
            : !probe.graphite.initialized
              ? "gt-uninitialized"
              : "ready";
        let group = groups.get(key);
        if (group === undefined) {
          group = {
            key,
            label: path.basename(mainRoot),
            hostId: environment.hostId,
            environmentIds: [],
            preferred: null,
            mainRoot,
            status,
            message: status === "ready" ? null : status === "no-gt" ? "gt is not installed on this host" : status === "gt-uninitialized" ? "Graphite is not initialized" : "Unsupported gt version",
          };
          groups.set(key, group);
        }
        group.environmentIds.push(environment.id);
        if (probe.repo.root === mainRoot) group.preferred = environment.id;
      }
      return {
        repos: [...groups.values()].map((group) => ({
          key: group.key,
          label: group.label,
          hostId: group.hostId,
          environmentId: group.preferred ?? group.environmentIds[0]!,
          environmentIds: group.environmentIds,
          status: group.status,
          message: group.message,
        })),
        environmentsWithoutGit: withoutGit,
      };
    },

    prs: ({ environmentId, refresh }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return loadPrs(ctx, refresh);
      }),

    layerFiles: ({ environmentId, branch }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const { parent } = await parentOf(ctx, branch);
        const result = await host.call(
          "layerFiles",
          { cwd: ctx.cwd, branch, parent, maxFiles: 3000 },
          { hostId: ctx.hostId, timeoutMs: 60_000 },
        );
        return { ...result, viewed: store.listViewed(ctx.repoKey, branch) };
      }),

    filePatch: ({ environmentId, baseSha, headSha, path: filePath, oldPath }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const { patchLimitKb } = await settings.get();
        const maxBytes = Math.min(4096, Math.max(16, Math.floor(patchLimitKb))) * 1024;
        return host.call("filePatch", { cwd: ctx.cwd, baseSha, headSha, path: filePath, oldPath, maxBytes }, { hostId: ctx.hostId, timeoutMs: 60_000 });
      }),

    fileSides: ({ environmentId, baseSha, headSha, path: filePath, oldPath }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return host.call(
          "fileSides",
          { cwd: ctx.cwd, baseSha, headSha, path: filePath, oldPath, maxBytes: 1024 * 1024 },
          { hostId: ctx.hostId, timeoutMs: 60_000 },
        );
      }),

    uncommitted: ({ environmentId, worktreePath }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        await requireWorktree(ctx, worktreePath);
        return host.call("uncommitted", { cwd: ctx.cwd, worktreePath, maxFiles: 2000 }, { hostId: ctx.hostId });
      }),

    uncommittedPatch: ({ environmentId, worktreePath, path: filePath, untracked }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        await requireWorktree(ctx, worktreePath);
        const { patchLimitKb } = await settings.get();
        const maxBytes = Math.min(4096, Math.max(16, Math.floor(patchLimitKb))) * 1024;
        return host.call("uncommittedPatch", { cwd: ctx.cwd, worktreePath, path: filePath, untracked, maxBytes }, { hostId: ctx.hostId });
      }),

    setViewed: ({ environmentId, branch, path: filePath, fileKey, viewed }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        store.setViewed(ctx.repoKey, branch, filePath, fileKey, viewed);
        publish(ctx.repoKey);
        return { viewed: store.listViewed(ctx.repoKey, branch) };
      }),

    linkThread: ({ environmentId, branch, threadId }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const topology = await topologyOf(ctx);
        if (!topology.branches.some((candidate) => candidate.name === branch)) {
          throw new UserError(`${branch} is not tracked by Graphite.`);
        }
        const thread = await validateThreadForRepo(ctx, threadId);
        const row = store.setLink(ctx.repoKey, branch, thread.id, thread.environmentId);
        publish(ctx.repoKey);
        return {
          branch,
          threadId: row.threadId,
          environmentId: row.environmentId,
          linkedAt: row.linkedAt,
          status: "valid" as const,
          thread: summarizeThread(thread),
        };
      }),

    unlinkThread: ({ environmentId, branch }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const removed = store.deleteLink(ctx.repoKey, branch);
        publish(ctx.repoKey);
        return { removed };
      }),

    notesList: ({ environmentId, branch }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const snapshot = await safeSnapshot(ctx, branch);
        const rows = store.listNotes(ctx.repoKey, branch);
        const roots = rows.filter((row) => row.parentId === null);
        const states = await anchorStates(ctx, snapshot, roots);
        // Newest threads first within a 2 MB reply budget; older ones are reported as truncated.
        const notes: Note[] = [];
        let budget = NOTES_REPLY_BUDGET;
        let truncated = false;
        for (const root of [...roots].reverse()) {
          const view = noteView(root, rows.filter((row) => row.parentId === root.id), states[root.id] ?? "unknown");
          const size = JSON.stringify(view).length;
          if (size > budget) {
            truncated = true;
            break;
          }
          budget -= size;
          notes.unshift(view);
        }
        return { notes, snapshot, truncated };
      }),

    noteCreate: ({ environmentId, branch, anchor, body, threadId }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const { lineText } = await anchorLineText(ctx, branch, anchor);
        if (store.countNotes(ctx.repoKey, branch) >= MAX_NOTES_PER_BRANCH) throw new UserError("This branch has too many notes.");
        let owner = threadId ?? store.getLink(ctx.repoKey, branch)?.threadId ?? null;
        if (owner !== null) {
          try {
            const thread = await bb.sdk.threads.get({ threadId: owner });
            if (thread.deletedAt !== null || thread.projectId !== ctx.projectId) owner = null;
          } catch {
            owner = null;
          }
        }
        const row = store.createNote({
          repoKey: ctx.repoKey,
          branch,
          path: anchor.path,
          side: anchor.side,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          baseSha: anchor.baseSha,
          headSha: anchor.headSha,
          lineText,
          body,
          threadId: owner,
          parentId: null,
        });
        publish(ctx.repoKey);
        return noteView(row, [], "current");
      }),

    noteUpdate: ({ environmentId, noteId, body }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const note = ownNote(ctx, noteId);
        if (note.parentId !== null || store.getNoteDelivery(note.id)) throw new UserError("Only local drafts can be edited.");
        const ok = store.updateNote(note.id, body);
        publish(ctx.repoKey);
        return { ok };
      }),

    noteReconcile: ({ environmentId, noteId }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        ownNote(ctx, noteId);
        const delivery = store.getNoteDelivery(noteId);
        if (!delivery) throw new UserError("This draft has not been sent.");
        if (delivery.status === "sent") return { status: "sent" as const };
        const result = await bb.sdk.threads.search({ query: delivery.batchId, limitPerGroup: "100" });
        const found = [...result.active.results, ...result.archived.results].some((item) => item.thread.id === delivery.threadId && item.matches.some((match) => match.sourceKind === "user_message" && match.text.includes(delivery.batchId)));
        if (found) { store.finishNoteDelivery(delivery.batchId, "sent"); publish(ctx.repoKey); return { status: "sent" as const }; }
        return { status: "unknown" as const };
      }),

    noteHide: ({ environmentId, noteId, hidden }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        ownNote(ctx, noteId);
        const ok = store.hideNote(noteId, hidden);
        publish(ctx.repoKey);
        return { ok };
      }),

    notesSend: ({ environmentId, branch, threadId, noteIds }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return withReviewLock(ctx.repoKey, `thread-notes:${branch}`, async () => {
          const link = store.getLink(ctx.repoKey, branch);
          if (!link || link.threadId !== threadId) throw new UserError("Link this branch to the destination thread first.");
          const thread = await validateThreadForRepo(ctx, threadId);
          if (thread.environmentId !== link.environmentId) throw new UserError("The linked thread changed environment. Link it again before sending.");
          if (new Set(noteIds).size !== noteIds.length) throw new UserError("A draft was selected more than once.");
          const notes = noteIds.map((id) => ownNote(ctx, id));
          if (notes.some((note) => note.branch !== branch || note.parentId !== null || note.resolved || store.getNoteDelivery(note.id))) throw new UserError("Only unresolved local drafts can be sent.");
          const snapshot = await safeSnapshot(ctx, branch);
          const states = await anchorStates(ctx, snapshot, notes);
          if (!snapshot || notes.some((note) => states[note.id] !== "current")) throw new UserError("Some comment lines changed. Review them before sending.");
          for (const note of notes) {
            const latest = store.getNote(note.id);
            if (!latest || latest.updatedAt !== note.updatedAt || latest.body !== note.body || latest.resolved || store.getNoteDelivery(note.id)) throw new UserError("A draft changed. Review the selection again.");
          }
          const batchId = randomUUID();
          const allRows = store.listNotes(ctx.repoKey, branch);
          const body = [`Review comments for ${branch}`, ...notes.map((note) => `\n**${note.path} · ${note.side} · ${note.startLine}${note.endLine === note.startLine ? "" : `–${note.endLine}`}**\n\n> ${note.lineText.replace(/\n/g, "\n> ")}\n\n${note.body}${allRows.filter((reply) => reply.parentId === note.id).map((reply) => `\n\nReply: ${reply.body}`).join("")}`), `\n<!-- graphite-review:${batchId} -->`].join("\n");
          if (body.length > 100_000) throw new UserError("The selected comments are too large to send together.");
          store.beginNoteDelivery(noteIds, threadId, batchId);
          publish(ctx.repoKey);
          try {
            const result = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: body, mentions: [] }] });
            const status = result.delivery === "queued" ? "queued" : "sent";
            store.finishNoteDelivery(batchId, status);
            publish(ctx.repoKey);
            return { status, message: null };
          } catch {
            store.finishNoteDelivery(batchId, "unknown");
            publish(ctx.repoKey);
            return { status: "unknown" as const, message: "The send result is unknown. Check the thread before taking further action." };
          }
        });
      }),

    noteReply: ({ environmentId, noteId, body }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const root = ownNote(ctx, noteId);
        if (root.parentId !== null) throw new UserError("Reply to the first note of a thread.");
        if (store.getNoteDelivery(root.id)) throw new UserError("Reply in the destination thread after sending.");
        if (store.countNotes(ctx.repoKey, root.branch) >= MAX_NOTES_PER_BRANCH) throw new UserError("This branch has too many notes.");
        store.createNote({ ...root, body, parentId: root.id });
        publish(ctx.repoKey);
        return { ok: true };
      }),

    noteSetResolved: ({ environmentId, noteId, resolved }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        ownNote(ctx, noteId);
        const ok = store.setNoteResolved(noteId, resolved);
        publish(ctx.repoKey);
        return { ok };
      }),

    noteDelete: ({ environmentId, noteId }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        ownNote(ctx, noteId);
        if (store.getNoteDelivery(noteId)) throw new UserError("Sent comments can only be hidden locally.");
        const ok = store.deleteNote(noteId);
        publish(ctx.repoKey);
        return { ok };
      }),

    draftGet: async ({ key }) => {
      const value = await bb.storage.kv.get<string>(`draft:${createHash("sha256").update(key).digest("hex")}`);
      return { value: typeof value === "string" ? value : null };
    },

    draftSet: async ({ key, value }) => {
      const kvKey = `draft:${createHash("sha256").update(key).digest("hex")}`;
      if (value === null || value === "") await bb.storage.kv.delete(kvKey);
      else await bb.storage.kv.set(kvKey, value);
      return { ok: true };
    },

    prThreads: ({ environmentId, branch }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const found = await prForBranch(ctx, branch);
        const snapshot = await safeSnapshot(ctx, branch);
        const pending = await pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), snapshot);
        if (found.pr === null || found.remote === null) {
          return { status: found.status, message: found.message, pr: null, viewer: null, threads: [], truncated: false, pending };
        }
        const threads = await host.call(
          "prThreads",
          { cwd: ctx.cwd, host: found.remote.host, owner: found.remote.owner, repo: found.remote.repo, number: found.pr.number },
          { hostId: ctx.hostId, timeoutMs: 60_000 },
        );
        return {
          status: threads.status,
          message: threads.message,
          pr: found.pr,
          viewer: threads.viewer,
          threads: threads.threads,
          truncated: threads.truncated,
          pending,
        };
      }),

    prReply: ({ environmentId, branch, threadId, body }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const found = await prForBranch(ctx, branch);
        if (found.pr === null || found.remote === null) throw new UserError(found.message ?? "No pull request for this branch.");
        let result;
        try {
          result = await host.call(
            "prReply",
            { cwd: ctx.cwd, host: found.remote.host, owner: found.remote.owner, repo: found.remote.repo, threadId, body },
            { hostId: ctx.hostId, timeoutMs: 60_000 },
          );
        } catch (error) {
          result = { outcome: "unknown" as const, message: `No confirmed reply: ${message(error)}. Refresh threads before you retry.`, id: null, url: null };
        }
        publish(ctx.repoKey);
        return result;
      }),

    prSetResolved: ({ environmentId, branch, threadId, resolved }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        const found = await prForBranch(ctx, branch);
        if (found.pr === null || found.remote === null) throw new UserError(found.message ?? "No pull request for this branch.");
        let result;
        try {
          result = await host.call(
            "prSetResolved",
            { cwd: ctx.cwd, host: found.remote.host, owner: found.remote.owner, repo: found.remote.repo, threadId, resolved },
            { hostId: ctx.hostId, timeoutMs: 60_000 },
          );
        } catch (error) {
          result = { outcome: "unknown" as const, message: `Not confirmed: ${message(error)}. Refresh threads.`, id: null, url: null };
        }
        publish(ctx.repoKey);
        return result;
      }),

    pendingAdd: ({ environmentId, branch, anchor, body }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return withReviewLock(ctx.repoKey, branch, async () => {
        const found = await prForBranch(ctx, branch);
        if (found.pr === null) throw new UserError(found.message ?? "No pull request for this branch.");
        if (found.pr.state !== "OPEN") throw new UserError(`PR #${found.pr.number} is ${found.pr.state.toLowerCase()}.`);
        const { snapshot, lineText } = await anchorLineText(ctx, branch, anchor);
        const existing = store.getPending(ctx.repoKey, branch);
        if (existing?.submission != null) throw new UserError("A submit is unconfirmed. Reconcile it first.");
        store.ensurePending(ctx.repoKey, branch, found.pr.number);
        store.addPendingComment(ctx.repoKey, branch, { ...anchor, lineText, body });
        publish(ctx.repoKey);
        return (await pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), snapshot))!;
        });
      }),

    pendingRemove: ({ environmentId, branch, commentId }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return withReviewLock(ctx.repoKey, branch, async () => {
        const existing = store.getPending(ctx.repoKey, branch);
        if (existing?.submission != null) throw new UserError("A submit is unconfirmed. Reconcile it first.");
        store.removePendingComment(ctx.repoKey, branch, commentId);
        const state = store.getPending(ctx.repoKey, branch);
        if (state !== null && state.comments.length === 0 && state.body.trim() === "") store.clearPending(ctx.repoKey, branch);
        publish(ctx.repoKey);
        return pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), await safeSnapshot(ctx, branch));
        });
      }),

    pendingSetBody: ({ environmentId, branch, body }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return withReviewLock(ctx.repoKey, branch, async () => {
        const existing = store.getPending(ctx.repoKey, branch);
        if (existing === null) {
          const found = await prForBranch(ctx, branch);
          if (found.pr === null) throw new UserError(found.message ?? "No pull request for this branch.");
          store.ensurePending(ctx.repoKey, branch, found.pr.number);
        } else if (existing.submission !== null) {
          throw new UserError("A submit is unconfirmed. Reconcile it first.");
        }
        store.setPendingBody(ctx.repoKey, branch, body);
        publish(ctx.repoKey);
        return pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), await safeSnapshot(ctx, branch));
        });
      }),

    submitReview: ({ environmentId, branch, event }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return withReviewLock(ctx.repoKey, branch, async () => {
        const state = store.getPending(ctx.repoKey, branch);
        const blocked = async (reason: string) => ({
          outcome: "blocked" as const,
          message: reason,
          url: null,
          pending: await pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), await safeSnapshot(ctx, branch)),
        });
        if (state === null) return blocked("There is no pending review. Add a comment or a summary first.");
        if (state.submission !== null) return blocked("An earlier submit has an unknown outcome. Reconcile it before you submit again.");
        if (event !== "APPROVE" && state.comments.length === 0 && state.body.trim() === "") {
          return blocked("Add a summary or a line comment for this review outcome.");
        }
        const found = await prForBranch(ctx, branch);
        if (found.pr === null || found.remote === null) return blocked(found.message ?? "No pull request for this branch.");
        if (found.pr.number !== state.prNumber) return blocked(`The pending review is for PR #${state.prNumber}, but the branch now has PR #${found.pr.number}.`);
        if (found.pr.state !== "OPEN") return blocked(`PR #${found.pr.number} is ${found.pr.state.toLowerCase()}.`);
        const snapshot = await currentSnapshot(ctx, branch);
        // Revalidate the head immediately before the shared write.
        if (snapshot.headSha !== found.pr.headRefOid) {
          return blocked(
            `The local head ${snapshot.headSha.slice(0, 7)} differs from the PR head ${found.pr.headRefOid.slice(0, 7)}. Submit the stack or refresh, then review again.`,
          );
        }
        const view = await pendingView(ctx, branch, state, snapshot);
        const stale = view?.comments.filter((comment) => comment.headSha !== found.pr!.headRefOid || comment.anchorState !== "current") ?? [];
        if (stale.length > 0) {
          return blocked(`${stale.length} pending comment(s) are outdated: ${stale.map((comment) => `${comment.path}:${comment.endLine}`).join(", ")}. Remove or re-add them.`);
        }
        const marker = `bb-graphite-stack:review:${randomUUID()}`;
        store.setPendingSubmission(ctx.repoKey, branch, { marker, state: "in-flight", startedAt: Date.now(), event }, null);
        publish(ctx.repoKey);
        let result;
        try {
          result = await host.call(
            "prSubmitReview",
            {
              cwd: ctx.cwd,
              host: found.remote.host,
              owner: found.remote.owner,
              repo: found.remote.repo,
              number: found.pr.number,
              commitId: found.pr.headRefOid,
              event,
              body: `${state.body.trim()}${state.body.trim() ? "\n\n" : ""}<!-- ${marker} -->`,
              // Only pending PR comments. Private BB notes are never part of this payload.
              comments: state.comments.map((comment) => ({
                path: comment.path,
                side: comment.side === "old" ? ("LEFT" as const) : ("RIGHT" as const),
                line: comment.endLine,
                startLine: comment.startLine < comment.endLine ? comment.startLine : null,
                body: comment.body,
              })),
            },
            { hostId: ctx.hostId, timeoutMs: 120_000 },
          );
        } catch (error) {
          result = { outcome: "unknown" as const, message: `No confirmed reply: ${message(error)}`, id: null, url: null };
        }
        if (result.outcome === "ok") {
          store.clearPending(ctx.repoKey, branch);
        } else if (result.outcome === "rejected") {
          store.setPendingSubmission(ctx.repoKey, branch, null, result.message);
        } else {
          store.setPendingSubmission(ctx.repoKey, branch, { marker, state: "unknown", startedAt: Date.now(), event }, result.message);
        }
        publish(ctx.repoKey);
        return {
          outcome: result.outcome,
          message: result.message,
          url: result.url,
          pending: await pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), snapshot),
        };
        });
      }),

    reconcileReview: ({ environmentId, branch }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return withReviewLock(ctx.repoKey, branch, async () => {
        const state = store.getPending(ctx.repoKey, branch);
        if (state === null || state.submission === null) {
          return { outcome: "nothing" as const, message: null, pending: await pendingView(ctx, branch, state, await safeSnapshot(ctx, branch)) };
        }
        const topology = await topologyOf(ctx);
        if (topology.remote === null) return { outcome: "error" as const, message: "No GitHub remote.", pending: await pendingView(ctx, branch, state, null) };
        const found = await host.call(
          "prFindMarker",
          { cwd: ctx.cwd, host: topology.remote.host, owner: topology.remote.owner, repo: topology.remote.repo, number: state.prNumber, marker: state.submission.marker },
          { hostId: ctx.hostId, timeoutMs: 60_000 },
        );
        if (found.status === "found") {
          store.clearPending(ctx.repoKey, branch);
          publish(ctx.repoKey);
          return { outcome: "posted" as const, message: found.url ? `The review is on GitHub: ${found.url}` : "The review is on GitHub.", pending: null };
        }
        if (found.status === "not-found") {
          store.setPendingSubmission(ctx.repoKey, branch, null, "The earlier submit did not reach GitHub. You can submit again.");
          publish(ctx.repoKey);
          return { outcome: "not-posted" as const, message: "GitHub has no review from that submit. The draft is kept; you can submit again.", pending: await pendingView(ctx, branch, store.getPending(ctx.repoKey, branch), await safeSnapshot(ctx, branch)) };
        }
        return { outcome: "error" as const, message: found.message, pending: await pendingView(ctx, branch, state, await safeSnapshot(ctx, branch)) };
        });
      }),

    previewOperation: ({ environmentId, request }) =>
      guarded(async (): Promise<OperationPreview> => {
        const ctx = await requireRepo(environmentId);
        const { plan } = await planFor(ctx, request);
        let dryRunOutput: string | null = null;
        if (request.kind === "submit" && plan.blockers.length === 0) {
          const dry = await host.call(
            "gt",
            { cwd: ctx.cwd, command: { kind: "submit", branch: request.branch, stack: request.stack, dryRun: true }, timeoutMs: 120_000 },
            { hostId: ctx.hostId, timeoutMs: 180_000 },
          );
          dryRunOutput = outputOf(dry) || "(no output)";
          if (dry.exitCode !== 0) plan.blockers.push("gt submit --dry-run failed. Read its output below.");
        }
        if (locks.has(ctx.repoKey)) plan.blockers.push("Another Graphite action is running in this repository.");
        const token = randomUUID();
        tokens.set(token, {
          environmentId,
          request: JSON.stringify(request),
          heads: await headsOf(ctx, plan.pinnedBranches),
          createdAt: Date.now(),
          repoKey: ctx.repoKey,
        });
        for (const [key, value] of tokens) if (Date.now() - value.createdAt > TOKEN_TTL_MS) tokens.delete(key);
        return {
          token,
          title: plan.title,
          allowed: plan.blockers.length === 0,
          blockers: plan.blockers,
          warnings: plan.warnings,
          steps: plan.steps.map(publicStep),
          dryRunOutput,
        };
      }),

    runOperation: ({ environmentId, request, token }) =>
      guarded(async (): Promise<OperationResult> => {
        const ctx = await requireRepo(environmentId);
        const rejected = (summary: string, steps: OperationStep[] = []): OperationResult => ({
          id: randomUUID(),
          outcome: "rejected",
          summary,
          steps,
          output: "",
          finishedAt: Date.now(),
        });
        const saved = tokens.get(token);
        tokens.delete(token);
        if (saved === undefined || saved.environmentId !== environmentId || saved.request !== JSON.stringify(request) || saved.repoKey !== ctx.repoKey) {
          return rejected("The preview is missing or does not match. Preview the action again.");
        }
        if (Date.now() - saved.createdAt > TOKEN_TTL_MS) return rejected("The preview expired. Preview the action again.");
        if (locks.has(ctx.repoKey)) return rejected("Another Graphite action is running in this repository.");
        locks.add(ctx.repoKey);
        publish(ctx.repoKey);
        try {
          const fresh = await requireRepo(environmentId);
          const { plan } = await planFor(fresh, request);
          if (plan.blockers.length > 0) return rejected(plan.blockers.join(" "), plan.steps.map(publicStep));
          const heads = await headsOf(fresh, Object.keys(saved.heads));
          const changed = Object.keys(saved.heads).filter((name) => heads[name] !== saved.heads[name]);
          if (changed.length > 0) {
            return rejected(`These branches changed after the preview: ${changed.join(", ")}. Preview again.`, plan.steps.map(publicStep));
          }
          const executed = await executePlan(fresh, request, plan.steps, plan.affected ?? []);
          const outcome = summarizeOutcome(executed.steps);
          const counts = (status: string) => executed.steps.filter((step) => step.status === status).length;
          const result: OperationResult = {
            id: randomUUID(),
            outcome,
            summary:
              outcome === "success"
                ? `${plan.title}: done.`
                : `${plan.title}: ${counts("done")} done, ${counts("up-to-date")} up to date, ${counts("conflict")} conflict, ${counts("failed")} failed, ${counts("skipped-by-gt") + counts("blocked")} not run by gt, ${counts("pending")} pending.`,
            steps: executed.steps,
            output: executed.output.join("\n\n").slice(-16_000),
            finishedAt: Date.now(),
          };
          store.recordOperation(ctx.repoKey, result);
          return result;
        } finally {
          locks.delete(ctx.repoKey);
          worktreeCache.delete(ctx.repoKey);
          publish(ctx.repoKey);
        }
      }),

    lastOperation: ({ environmentId }) =>
      guarded(async () => {
        const ctx = await requireRepo(environmentId);
        return { result: store.lastOperation(ctx.repoKey) };
      }),
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb graphite-stack stack <environment-id> [--json]",
    "  bb graphite-stack notes <environment-id> <branch> [--json]",
  ].join("\n");
  bb.cli.register({
    name: "graphite-stack",
    summary: "Read local Graphite stacks and private review notes",
    commands: [
      { name: "stack", summary: "Show the Graphite stack of an environment", usage: "bb graphite-stack stack <environment-id> [--json]" },
      { name: "notes", summary: "List private notes on a branch", usage: "bb graphite-stack notes <environment-id> <branch> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const out = (value: unknown, text: string) => {
        const stdout = json ? JSON.stringify(value) : text;
        return { exitCode: 0, stdout: stdout.length > 60_000 ? `${stdout.slice(0, 60_000)}\n…(truncated)` : stdout };
      };
      try {
        if (command === "stack" && args.length === 1) {
          const view = await buildStack(args[0]!);
          if (view.status !== "ready") return out(view, `${view.status}: ${view.message ?? ""}`);
          const lines = view.layers
            .filter((layer) => !layer.trunk)
            .map(
              (layer) =>
                `${layer.name} <- ${layer.parent}  ${layer.commitCount} commit(s)${layer.needsRestack ? "  needs restack" : ""}${layer.worktreePath ? `  [${layer.worktreePath}]` : ""}${layer.link ? `  thread ${layer.link.threadId} (${layer.link.status})` : ""}`,
            );
          return out(view, [`Trunks: ${view.trunks.join(", ")}`, `Current: ${view.currentBranch ?? "(detached)"}`, ...lines].join("\n"));
        }
        if (command === "notes" && args.length === 2) {
          const ctx = await requireRepo(args[0]!);
          const notes = store.listNotes(ctx.repoKey, args[1]!);
          return out(
            notes,
            notes.length === 0
              ? "No notes."
              : notes
                  .map((note) => `${note.parentId ? "  ↳" : `[${note.resolved ? "resolved" : "open"}] ${note.path}:${note.endLine} (${note.side}) @${note.headSha.slice(0, 7)}`} ${note.body}`)
                  .join("\n"),
          );
        }
      } catch (error) {
        return { exitCode: 1, stderr: message(error) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
