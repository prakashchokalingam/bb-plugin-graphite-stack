# Graphite Stack for BB

Review and operate **local** Graphite stacks inside BB. The plugin reads the
stack that `gt` tracks on each environment's machine. It needs no pull request,
no GitHub authentication, and no Git remote. PR data from GitHub is optional
enrichment.

## What you get

- **Graphite tab** on every thread. It shows the stack of the thread's
  environment: the stack rail, each layer's true Graphite parent, commits,
  restack state, worktrees, and the linked BB thread.
- **Graphite stacks page** in the navigation rail. Pick a project to see every
  Graphite repository in it, then open any stack.
- **Layer review without a checkout.** Select a layer to see only its changes
  against its Graphite parent (merge base of parent and branch, pinned to
  commit SHAs). Files load lazily, one patch at a time, in an inline review diff or BB's native
  `experimental_Diff` (unified or split, expand context when both file sides
  are small text). Mark files viewed; the mark resets when the file changes.
- **Uncommitted changes** of a worktree show in their own section, apart from
  committed layer changes.
- **Local line comments** on any layer, with replies, edit, local resolve,
  and delete. A comment keeps its original commit, path, side, and line range.
  Changed lines show as outdated. Select local drafts to preview and send one
  message to a linked BB thread. Sent, queued, and uncertain outcomes have
  separate labels. Local comments are not sent to GitHub.
- **PR review** (only when the branch has a GitHub PR and `gh` is
  authenticated on that machine): read review threads, reply, resolve and
  reopen, build a pending review, then submit it as Comment, Approve, or
  Request changes. Links open the canonical Graphite PR page.
- **Stack actions through `gt`**: initialize, create, track, restack
  (only/upstack/stack), sync, draft submit, and continue or abort an actual
  in-progress Graphite rebase. Every action shows a preview with the exact
  commands, affected branches, blockers, and warnings before it runs.
- **Thread association**: link one primary BB thread per branch, open it,
  reuse a thread that already works in that branch's worktree, or start a new
  thread from BB's own composer.

## Requirements and supported versions

| Tool | Requirement |
| --- | --- |
| BB | 0.48 or later, Plugin SDK 0.6.94 |
| Graphite CLI | `gt` 1.8 or later 1.x on the environment's machine. Tested: **1.8.6**. |
| git | 2.31 or later (uses `rev-parse --path-format=absolute`) |
| GitHub CLI | Optional. `gh` authenticated on the machine enables PR features. |

Each command runs on the machine that owns the environment, through the
plugin's host entry. The plugin uses that machine's `gt`, `git`, and `gh`
with their own configuration and authentication. It stores no tokens.

## Install

Install from GitHub with credentials that can access this private repository:

```sh
bb plugin install https://github.com/prakashchokalingam/bb-plugin-graphite-stack
```

For local development, install from this directory:

```sh
npm install --include=dev
bb plugin build
bb plugin install .
```

Then open a thread whose environment is a Git repository with Graphite, and
select the **Graphite** tab. Or open **Graphite stacks** in the navigation rail.

## How the plugin reads a stack

1. `git rev-parse` finds the repository and its common directory.
2. The plugin checks that `<common dir>/.graphite_repo_config` exists. It only
   checks existence. `gt state` initializes Graphite in an uninitialized
   repository, so the plugin never runs it there; it shows an **Initialize**
   action instead.
3. `gt state --no-interactive` prints Graphite's branch graph as JSON. The
   plugin validates it with a schema: every non-trunk branch has exactly one
   parent, every parent is a tracked branch, at least one trunk exists, and no
   cycle exists. Output that fails validation shows an "unsupported gt
   output" state. The plugin never infers parents from commit ancestry.
4. git supplies heads and worktree names for the initial view. Commit details
   and worktree status load for the visible stack; All loads details in batches.

The plugin never reads or writes Graphite's private files. Only `gt` changes
Graphite metadata.

`gt state` is a documented command ("Display information about the state of
the repo"). Its JSON shape is not a published stable contract. The adapter is
tested against gt 1.8.6 output fixtures and real repositories.

## Safety rules

- Every process gets an argument array (no shell), a timeout, and a byte cap.
  Children run in their own process group, without a terminal, so ssh and
  credential helpers cannot prompt; a timeout stops the whole group.
- git reads use literal pathspecs, so names such as `src/a[1].ts` or
  `-notes.md` mean exactly that file.
- Branch names pass a Git-compatible check and `git check-ref-format`. Names
  that start with `-` are refused.
- Diffs use pinned commit SHAs that `git rev-parse --verify` confirmed.
- Remote URLs and command output are redacted before they leave the machine.

### Mutations

- A preview returns a single-use token valid for 5 minutes. A run needs that
  token and the same request.
- One action at a time per repository (per host and Git common directory).
- Right before the run, the plugin reads the repository again. It rejects the
  run when a pinned branch moved, a worktree is dirty or mid-rebase, a status
  read failed, or an agent is active in an affected worktree. Active agents
  come from `threads.listRunning`, across all projects. If that read fails,
  the action is blocked.
- Restack runs one `gt restack --only` per branch, parent before child, in the
  branch's own worktree (gt skips branches checked out in another worktree).
  After each step the plugin reads `gt state` again. A branch that still needs
  a restack is reported as **not run by gt**, never as success. The run stops
  at the first conflict, failure, or block; later branches stay **pending**.
- Continue and Abort appear only when a rebase is actually in progress in that
  worktree. Continue requires that no conflicted files remain.
- Not in this release: force push, auto-stash, merge, prune/delete-all, and
  Magic Stack. Submit always passes `--draft`, never `--force` (gt pushes with
  `--force-with-lease` by default). Sync never passes `--force` or
  `--delete-all`.

### Sync limits

Sync runs `gt sync --no-interactive` once, in the environment's worktree. It
is not an ordered sync of every worktree. gt can overwrite local trunk when
trunk cannot fast-forward (documented gt behavior). The result lists every
tracked branch: deleted, still needs a restack (gt skipped it), or up to date.
Any skipped branch makes the result **partial**.

### PR writes

- Writes happen only on explicit buttons: Reply, Resolve/Reopen, Submit review.
- Submit sends one GitHub "create review" call with only the pending PR
  comments. Private notes are a separate store and are never in the payload.
- Before submit, the plugin checks that the PR is open, that the local branch
  head equals the PR head, and that every pending comment's range text is
  unchanged at that head.
- The review body carries a hidden marker. When a submit times out or GitHub
  returns a server error, the outcome is **unknown**: the draft is kept, new
  submits are blocked, and **Reconcile** searches the PR's reviews for the
  marker. Found: the draft is cleared. Not found: you can submit again.
- A rejected submit (for example, a line outside the PR diff) keeps the draft
  and shows GitHub's reason.
- Review writes are serialized per branch.

## Freshness

The host watches the repository's Git directory and signals on ref, HEAD,
packed-refs, rebase, and `.graphite_repo_config` changes. It ignores
`.graphite_metadata.db` (gt rewrites it during reads) and `index`, so a read
never triggers itself. Limit: a `gt track`/`untrack` outside BB that moves no
ref shows on the next refresh. PR data refreshes on request and is cached;
when GitHub fails, the last good PR data shows with its age, and local data
is never hidden.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Largest patch to load (KB) | 1024 | Patches over this size show as truncated (16–4096). |
| Commits to list per branch | 50 | Commit list length per layer (1–200). |

## CLI

```sh
bb graphite-stack stack <environment-id> [--json]
bb graphite-stack notes <environment-id> <branch> [--json]
```

Both commands only read.

## Known limits

- Inline review uses a line button and a line-range form. The native diff
  remains available, but its selection does not open the comment composer.
- Thread sends start a turn or queue behind an active thread. When a send
  outcome is uncertain, the plugin blocks a duplicate send and offers a
  thread search. A missing search result does not prove delivery failed.
- Local resolve or hide does not change the sent thread message or a GitHub PR.
  GitHub PR replies and resolution use explicit remote actions.
- New threads are created only from BB's new-thread composer, by the user.
- Review threads show the first 100 threads and 50 comments per thread; the
  UI marks longer lists as partial.
- PR features need a GitHub remote on github.com or `*.ghe.com`. Graphite
  links are shown for github.com only.
- Notes list returns the newest threads within a 2 MB reply; older ones are
  reported as not shown.

## Development

```sh
npm test            # vitest: parsers, planner, host + server against real gt
npm run typecheck
bb plugin build
```

Integration tests create disposable repositories in the OS temp directory and
point gt at a temporary `XDG_*` config, so they never touch your repositories
or Graphite configuration. They skip when `gt` is missing.

Missing Graphite parents do not hide the stack. The view preserves the reported parent name and marks incomplete layers. Stack mutations stay blocked until the parent is repaired; recovery actions remain available. The plugin does not infer replacement parents.
