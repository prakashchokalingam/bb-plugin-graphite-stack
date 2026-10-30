// bb.host entry: runs on the host that owns each environment. It runs git,
// gt, and gh with argument arrays, timeouts, and byte caps. It reads Graphite
// topology only through `gt state` and never reads or writes Graphite files.
import { experimental_defineHostEntry, type ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract";
import * as github from "./lib/github";
import * as gitops from "./lib/gitops";
import { runProcess, withSignal, type Runner } from "./lib/process";

const watches = new Map<string, ExperimentalHostWatchSubscription>();

/**
 * Changes that move refs, HEAD, or an in-progress operation. `gt state`
 * rewrites `.graphite_metadata.db` during reads and git rewrites `index`, so
 * those paths never trigger a refresh; otherwise a read invalidates itself.
 */
export function isSemanticRepoChange(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/u).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (name.endsWith(".lock") || name.startsWith(".graphite_metadata")) return false;
  if (parts[0] === "refs" || name === "packed-refs" || name === ".graphite_repo_config") return true;
  if (name === "HEAD" || name === "MERGE_HEAD" || name === "CHERRY_PICK_HEAD" || name === "REVERT_HEAD") return true;
  return parts.includes("rebase-merge") || parts.includes("rebase-apply");
}
const MIN_SIGNAL_INTERVAL_MS = 1500;

export function createHostEntry(run: Runner = runProcess) {
  // Every handler passes its request signal to the processes it starts.
  const bind = (context: { signal: AbortSignal }) => withSignal(run, context.signal);
  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      probe: ({ cwd }, context) => gitops.probe(bind(context), cwd),
      readStack: ({ cwd, environmentPaths, commitLimit, detailBranches }, context) => gitops.readStack(bind(context), cwd, environmentPaths, commitLimit, detailBranches),
      topology: ({ cwd }, context) => gitops.topology(bind(context), cwd),
      snapshot: ({ cwd, branch, parent }, context) => gitops.snapshot(bind(context), cwd, branch, parent),
      worktreeStatus: ({ worktreePath }, context) => gitops.worktreeStatus(bind(context), worktreePath),
      refHeads: ({ cwd, branches }, context) => gitops.refHeads(bind(context), cwd, branches),
      layerFiles: ({ cwd, branch, parent, maxFiles }, context) => gitops.layerFiles(bind(context), cwd, branch, parent, maxFiles),
      filePatch: ({ cwd, baseSha, headSha, path, oldPath, maxBytes }, context) =>
        gitops.filePatch(bind(context), cwd, baseSha, headSha, path, oldPath, maxBytes),
      fileSides: ({ cwd, baseSha, headSha, path, oldPath, maxBytes }, context) =>
        gitops.fileSides(bind(context), cwd, baseSha, headSha, path, oldPath, maxBytes),
      uncommitted: ({ worktreePath, maxFiles }, context) => gitops.uncommitted(bind(context), worktreePath, maxFiles),
      uncommittedPatch: ({ worktreePath, path, untracked, maxBytes }, context) =>
        gitops.uncommittedPatch(bind(context), worktreePath, path, untracked, maxBytes),
      readLines: ({ cwd, sha, path, start, end }, context) => gitops.readLines(bind(context), cwd, sha, path, start, end),
      checkAnchors: ({ cwd, baseSha, headSha, anchors }, context) => gitops.checkAnchors(bind(context), cwd, baseSha, headSha, anchors),
      gt: ({ cwd, command, timeoutMs }, context) => gitops.runGt(bind(context), cwd, command, timeoutMs),
      prList: ({ cwd, host, owner, repo, branches }, context) => github.listPrs(bind(context), { cwd, host, owner, repo }, branches),
      prThreads: ({ cwd, host, owner, repo, number }, context) => github.listThreads(bind(context), { cwd, host, owner, repo }, number),
      prReply: ({ cwd, host, owner, repo, threadId, body }, context) =>
        github.replyToThread(bind(context), { cwd, host, owner, repo }, threadId, body),
      prSetResolved: ({ cwd, host, owner, repo, threadId, resolved }, context) =>
        github.setThreadResolved(bind(context), { cwd, host, owner, repo }, threadId, resolved),
      prSubmitReview: ({ cwd, host, owner, repo, number, commitId, event, body, comments }, context) =>
        github.submitReview(bind(context), { cwd, host, owner, repo }, number, commitId, event, body, comments),
      prFindMarker: ({ cwd, host, owner, repo, number, marker }, context) =>
        github.findReviewMarker(bind(context), { cwd, host, owner, repo }, number, marker),
      watchRepo: async ({ commonDir }, context) => {
        const root = gitops.safeRealpath(commonDir);
        if (watches.has(root)) return { watching: true, error: null };
        let lastSignal = 0;
        let trailing: ReturnType<typeof setTimeout> | null = null;
        try {
          const subscription = await context.experimental_watch(
            {
              rootPath: root,
              // Object writes are frequent and carry no topology change.
              ignoredPaths: ["objects", "logs", "lfs", "hooks", "modules", "index"],
              debounceMs: 400,
              maxWaitMs: 3000,
            },
            async (event) => {
              if (event.kind === "watch-error") {
                watches.delete(root);
                return;
              }
              if (event.kind === "changed") {
                const relevant = event.changes.some((change) => {
                  const relative = change.path.startsWith(root) ? change.path.slice(root.length) : change.path;
                  return isSemanticRepoChange(relative);
                });
                if (!relevant) return;
              }
              // Coalesce bursts, but always send a trailing signal so no change is lost.
              const wait = lastSignal + MIN_SIGNAL_INTERVAL_MS - Date.now();
              if (wait > 0) {
                if (trailing === null) {
                  trailing = setTimeout(() => {
                    trailing = null;
                    lastSignal = Date.now();
                    context.experimental_emitSignal("repoChanged", { commonDir: root }).catch(() => {});
                  }, wait);
                }
                return;
              }
              lastSignal = Date.now();
              await context.experimental_emitSignal("repoChanged", { commonDir: root });
            },
          );
          watches.set(root, subscription);
          return { watching: true, error: null };
        } catch (error) {
          return { watching: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    dispose: async () => {
      const all = [...watches.values()];
      watches.clear();
      await Promise.allSettled(all.map((subscription) => subscription.dispose()));
    },
  });
}

export default createHostEntry();
