// Pure planning for Graphite mutations. The server feeds the current
// topology, worktrees, and busy environments; the plan lists every affected
// branch with the exact gt argv, plus blockers and warnings.
import type { OperationRequest, OperationStep } from "../contract";
import { gtArgv } from "./gitops";
import type { GtCommand, WorktreeInfo } from "./model";
import { ancestorsOf, childrenOf, descendantsOf } from "./parse";

export interface PlanInput {
  request: OperationRequest;
  initialized: boolean;
  trunks: string[];
  branches: { name: string; parent: string | null; trunk: boolean; needsRestack: boolean }[];
  localBranches: Set<string>;
  worktrees: WorktreeInfo[];
  anchorPath: string;
  /** Environment id -> titles of threads that are running. */
  busy: Map<string, string[]>;
  hasRemote: boolean;
  hasGithubRemote: boolean;
}

export interface PlannedStep extends OperationStep {
  command: GtCommand;
  /** Absolute cwd for the gt call. */
  cwd: string;
}

export interface Plan {
  title: string;
  blockers: string[];
  warnings: string[];
  steps: PlannedStep[];
  /** Branches whose heads the run must find unchanged. */
  pinnedBranches: string[];
  /** Branches that the action changes or publishes, in order. */
  affected?: string[];
}

function short(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

export function worktreeProblems(
  worktree: WorktreeInfo,
  busy: Map<string, string[]>,
  options: { requireClean: boolean; allowOperation?: boolean },
): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const name = `Worktree ${short(worktree.path)}${worktree.branch ? ` (${worktree.branch})` : ""}`;
  // A status that could not be read is never a clean tree.
  if (worktree.statusError !== null) blockers.push(`${name}: status is unknown (${worktree.statusError})`);
  if (worktree.operation !== null && options.allowOperation !== true) {
    blockers.push(`${name} has a ${worktree.operation} in progress. Continue or abort it first.`);
  }
  if (options.requireClean) {
    if (worktree.conflicted > 0) blockers.push(`${name} has ${worktree.conflicted} conflicted files`);
    if (worktree.staged + worktree.unstaged > 0) {
      blockers.push(`${name} has uncommitted changes (${worktree.staged} staged, ${worktree.unstaged} unstaged). Commit or stash them yourself first.`);
    }
    if (worktree.untracked > 0) warnings.push(`${name} has ${worktree.untracked} untracked files`);
  }
  const titles = worktree.environmentIds.flatMap((id) => busy.get(id) ?? []);
  if (titles.length > 0) {
    blockers.push(`${name}: agent is active in ${titles.map((title) => `"${title}"`).join(", ")}. Wait until it is idle.`);
  }
  return { blockers, warnings };
}

export function planOperation(input: PlanInput): Plan {
  const { request } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const steps: PlannedStep[] = [];
  const byName = new Map(input.branches.map((branch) => [branch.name, branch]));
  const parentOf = new Map(input.branches.map((branch) => [branch.name, branch.parent]));
  const children = childrenOf(input.branches);
  const anchor = input.worktrees.find((worktree) => worktree.path === input.anchorPath) ?? null;
  const worktreeOf = (branch: string) => input.worktrees.find((worktree) => worktree.branch === branch && !worktree.bare) ?? null;
  const step = (command: GtCommand, cwd: string, branch: string | null, worktree: WorktreeInfo | null, message: string | null = null): PlannedStep => ({
    command,
    cwd,
    branch,
    worktreePath: worktree?.path ?? cwd,
    environmentId: worktree?.environmentId ?? null,
    argv: ["gt", ...gtArgv(command)],
    status: "pending",
    message,
  });
  const add = (problems: { blockers: string[]; warnings: string[] }) => {
    for (const blocker of problems.blockers) if (!blockers.includes(blocker)) blockers.push(blocker);
    for (const warning of problems.warnings) if (!warnings.includes(warning)) warnings.push(warning);
  };
  if (anchor === null) {
    return { title: "Operation", blockers: ["The environment is not a worktree of this repository"], warnings, steps, pinnedBranches: [] };
  }
  // A rebase anywhere in the repository blocks every action except recovery.
  if (request.kind !== "recover") {
    for (const worktree of input.worktrees) {
      if (worktree.operation !== null) {
        blockers.push(`Worktree ${short(worktree.path)} has a ${worktree.operation} in progress. Continue or abort it first.`);
      }
    }
  }
  if (request.kind !== "recover") {
    for (const branch of input.branches) {
      if (branch.parent !== null && (!byName.has(branch.parent) || !input.localBranches.has(branch.parent))) {
        blockers.push(`Graphite parent ${branch.parent} for ${branch.name} is missing from the tracked stack or local refs. Repair the Graphite parent before stack actions.`);
      }
    }
  }
  if (request.kind !== "init" && !input.initialized) blockers.push("Graphite is not initialized in this repository");

  switch (request.kind) {
    case "init": {
      if (input.initialized) blockers.push("Graphite is already initialized");
      if (!input.localBranches.has(request.trunk)) blockers.push(`Branch ${request.trunk} does not exist`);
      add(worktreeProblems(anchor, input.busy, { requireClean: false }));
      steps.push(step({ kind: "init", trunk: request.trunk }, anchor.path, request.trunk, anchor));
      return { title: `Initialize Graphite with trunk ${request.trunk}`, blockers, warnings, steps, pinnedBranches: [] };
    }
    case "create": {
      const current = anchor.branch;
      if (current === null) blockers.push("The environment has a detached HEAD");
      else if (!byName.has(current)) blockers.push(`Current branch ${current} is not tracked. Track it first.`);
      if (input.localBranches.has(request.name) || byName.has(request.name)) blockers.push(`Branch ${request.name} already exists`);
      add(worktreeProblems(anchor, input.busy, { requireClean: false }));
      if (anchor.conflicted > 0) blockers.push("The worktree has conflicted files");
      if (!request.stageAll && anchor.staged === 0) {
        warnings.push("No staged changes. gt creates the branch without a new commit.");
      }
      if (request.stageAll && anchor.untracked > 0) warnings.push(`Stage all includes ${anchor.untracked} untracked files`);
      steps.push(step({ kind: "create", name: request.name, message: request.message, stageAll: request.stageAll }, anchor.path, request.name, anchor, current === null ? null : `New branch on ${current}`));
      return { title: `Create ${request.name}${current ? ` on ${current}` : ""}`, blockers, warnings, steps, pinnedBranches: current ? [current] : [] };
    }
    case "track": {
      if (byName.has(request.branch)) blockers.push(`Branch ${request.branch} is already tracked`);
      if (!input.localBranches.has(request.branch) && !byName.has(request.branch)) blockers.push(`Branch ${request.branch} does not exist`);
      if (!byName.has(request.parent)) blockers.push(`Parent ${request.parent} is not tracked by Graphite`);
      if (request.parent === request.branch) blockers.push("A branch cannot be its own parent");
      add(worktreeProblems(anchor, input.busy, { requireClean: false }));
      const own = worktreeOf(request.branch);
      if (own !== null && own.path !== anchor.path) add(worktreeProblems(own, input.busy, { requireClean: false }));
      steps.push(step({ kind: "track", branch: request.branch, parent: request.parent }, anchor.path, request.branch, worktreeOf(request.branch), `Parent: ${request.parent}`));
      return { title: `Track ${request.branch} on ${request.parent}`, blockers, warnings, steps, pinnedBranches: [request.branch, request.parent] };
    }
    case "restack": {
      const target = byName.get(request.branch);
      if (target === undefined) {
        blockers.push(`Branch ${request.branch} is not tracked`);
        return { title: `Restack ${request.branch}`, blockers, warnings, steps, pinnedBranches: [] };
      }
      let order: string[] = [];
      if (request.scope === "only") order = [request.branch];
      else if (request.scope === "upstack") order = [request.branch, ...descendantsOf(request.branch, children)];
      else {
        const ancestors = ancestorsOf(request.branch, parentOf).reverse();
        order = [...ancestors, request.branch, ...descendantsOf(request.branch, children)];
      }
      order = order.filter((name) => !byName.get(name)?.trunk);
      if (order.length === 0) blockers.push("Trunk branches are not restacked");
      for (const name of order) {
        const own = worktreeOf(name);
        // gt skips a branch that is checked out in another worktree, so the
        // plugin runs each branch inside its own worktree.
        const executor = own ?? anchor;
        add(worktreeProblems(executor, input.busy, { requireClean: true }));
        const needs = byName.get(name)?.needsRestack === true;
        steps.push(
          step(
            { kind: "restack-only", branch: name },
            executor.path,
            name,
            executor,
            own === null
              ? `Runs in ${short(anchor.path)}${needs ? "" : "; currently up to date"}`
              : `Runs in its own worktree ${short(own.path)}${needs ? "" : "; currently up to date"}`,
          ),
        );
      }
      return {
        title: `Restack ${request.scope === "only" ? request.branch : `${request.scope} of ${request.branch}`}`,
        blockers,
        warnings,
        steps,
        pinnedBranches: order.flatMap((name) => [name, parentOf.get(name) ?? null]).filter((name): name is string => name !== null),
      };
    }
    case "sync": {
      if (!input.hasRemote) blockers.push("This repository has no Git remote. gt sync needs one.");
      const trackedNames = new Set(input.branches.map((branch) => branch.name));
      for (const worktree of input.worktrees) {
        if (worktree.bare || worktree.branch === null || !trackedNames.has(worktree.branch)) continue;
        add(worktreeProblems(worktree, input.busy, { requireClean: true }));
      }
      warnings.push("gt sync pulls trunk and restacks branches that restack without conflicts.");
      warnings.push("If trunk cannot fast-forward, gt sync overwrites local trunk with the remote version.");
      warnings.push("The plugin does not pass --force or --delete-all, so gt does not delete merged branches without a prompt.");
      warnings.push("This is one gt sync run in this worktree, not an ordered sync of every worktree. The result lists each branch; any branch gt skips makes the result partial.");
      for (const worktree of input.worktrees) {
        if (worktree.path !== anchor.path && worktree.branch !== null && trackedNames.has(worktree.branch) && !byName.get(worktree.branch)?.trunk) {
          warnings.push(`gt skips ${worktree.branch} because it is checked out in ${short(worktree.path)}; the result reports it.`);
        }
      }
      steps.push(step({ kind: "sync" }, anchor.path, null, anchor));
      return { title: "Sync with remote", blockers, warnings, steps, pinnedBranches: [...trackedNames] };
    }
    case "submit": {
      if (!input.hasGithubRemote) blockers.push("This repository has no GitHub remote. Submit needs one.");
      const target = byName.get(request.branch);
      if (target === undefined || target.trunk) {
        blockers.push(`Branch ${request.branch} is not a tracked non-trunk branch`);
        return { title: `Submit ${request.branch}`, blockers, warnings, steps, pinnedBranches: [] };
      }
      const ancestors = ancestorsOf(request.branch, parentOf).reverse().filter((name) => !byName.get(name)?.trunk);
      const affected = [...ancestors, request.branch, ...(request.stack ? descendantsOf(request.branch, children) : [])];
      for (const name of affected) {
        if (byName.get(name)?.needsRestack) blockers.push(`${name} needs a restack. Restack before submit.`);
        // An active agent can move a ref during the push.
        const own = worktreeOf(name);
        if (own !== null) {
          add(worktreeProblems(own, input.busy, { requireClean: false }));
          if (own.staged + own.unstaged + own.untracked > 0) {
            warnings.push(`${name} has uncommitted changes in ${short(own.path)}; submit publishes committed changes only.`);
          }
        }
      }
      add(worktreeProblems(anchor, input.busy, { requireClean: false }));
      warnings.push("New PRs are created as drafts. The plugin never passes --force; gt pushes with --force-with-lease.");
      steps.push(step({ kind: "submit", branch: request.branch, stack: request.stack, dryRun: false }, anchor.path, request.branch, anchor, `Submits ${affected.join(", ")}`));
      return { title: `Submit ${request.stack ? "stack of " : ""}${request.branch} as draft`, blockers, warnings, steps, pinnedBranches: affected, affected };
    }
    case "recover": {
      const worktree = input.worktrees.find((candidate) => candidate.path === request.worktreePath) ?? null;
      if (worktree === null) {
        blockers.push("That path is not a worktree of this repository");
        return { title: `${request.action === "continue" ? "Continue" : "Abort"} operation`, blockers, warnings, steps, pinnedBranches: [] };
      }
      if (worktree.operation !== "rebase") blockers.push(`No rebase is in progress in ${short(worktree.path)}`);
      add(worktreeProblems(worktree, input.busy, { requireClean: false, allowOperation: true }));
      if (request.action === "continue" && worktree.conflicted > 0) {
        blockers.push(`Resolve and stage ${worktree.conflicted} conflicted files before you continue`);
      }
      steps.push(step({ kind: request.action }, worktree.path, worktree.branch, worktree));
      return { title: `${request.action === "continue" ? "Continue" : "Abort"} the Graphite rebase in ${short(worktree.path)}`, blockers, warnings, steps, pinnedBranches: [] };
    }
  }
}

/** Summarize step results into one outcome. */
export function summarizeOutcome(steps: readonly OperationStep[]): "success" | "partial" | "conflict" | "failed" {
  if (steps.some((step) => step.status === "conflict")) return "conflict";
  const ok = steps.filter((step) => step.status === "done" || step.status === "up-to-date").length;
  if (ok === steps.length) return "success";
  return ok > 0 ? "partial" : "failed";
}
