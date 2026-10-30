---
name: graphite-stack
description: Read the local Graphite stack of a BB environment and its private review notes with the bb graphite-stack command. Use when a user asks about a Graphite stack, layer parents, restack state, or review notes in BB.
---

# Graphite Stack

The Graphite Stack plugin shows local Graphite stacks in BB. It reads the
stack that `gt` tracks on the environment's machine. It needs no PR, no
GitHub authentication, and no Git remote.

## Commands

Both commands only read.

```sh
bb graphite-stack stack <environment-id> [--json]
bb graphite-stack notes <environment-id> <branch> [--json]
```

- `stack` prints the trunks, the current branch, and each tracked branch with
  its Graphite parent, commit count, restack state, worktree, and linked BB
  thread. Status values other than `ready` explain why no stack is shown
  (`no-repo`, `no-gt`, `gt-uninitialized`, `gt-unsupported`, and others).
- `notes` prints the private BB line notes on one branch, with path, side,
  line, original commit, and resolved state.

Find your environment id with `bb status`.

## Rules for agents

1. Read the Graphite parent from `bb graphite-stack stack`. Do not infer it
   from commit ancestry.
2. Do not edit `.git/.graphite_*` files. Only `gt` changes Graphite metadata.
3. Use `gt` itself for stack changes. In BB, the user runs create, track,
   restack, sync, and submit from the Graphite tab, which previews each action.
4. Private notes stay in BB. Do not copy their text into a PR comment unless
   the user asks.
5. While you are active in a worktree, the plugin blocks stack actions on it.
   Finish your turn before the user restacks.

## Supported versions

gt 1.8 or later 1.x (tested 1.8.6), git 2.31 or later. `gh` is optional and
enables PR features.
