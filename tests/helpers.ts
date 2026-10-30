// Disposable git + gt repositories for integration tests. gt state and
// config go to a per-run XDG directory; the user's own Graphite config,
// credentials, and repositories are never touched.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess, type Runner } from "../lib/process";

const XDG_ROOT = mkdtempSync(path.join(os.tmpdir(), "gs-xdg-"));
export const TEST_ENV: Record<string, string> = {
  XDG_DATA_HOME: path.join(XDG_ROOT, "data"),
  XDG_CONFIG_HOME: path.join(XDG_ROOT, "config"),
  XDG_CACHE_HOME: path.join(XDG_ROOT, "cache"),
  XDG_STATE_HOME: path.join(XDG_ROOT, "state"),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) mkdirSync(TEST_ENV[key]!, { recursive: true });

export const hasGt = spawnSync("gt", ["--version"], { env: { ...process.env, ...TEST_ENV }, encoding: "utf8" }).status === 0;

/** Runner used by the host code under test, with the isolated gt config. */
export const testRunner: Runner = (command, args, options) =>
  runProcess(command, args, { ...options, env: { ...TEST_ENV, ...(options.env ?? {}) } });

export function sh(cwd: string, command: string, ...args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...TEST_ENV },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function git(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", ...args).trim();
}

export function gt(cwd: string, ...args: string[]): string {
  return sh(cwd, "gt", ...args, "--no-interactive");
}

export function write(root: string, file: string, content: string | Buffer) {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface StackFixture {
  root: string;
  uiWorktree: string;
  heads: () => Record<string, string>;
}

/**
 * main -> feature/model (2 commits) -> feature/api
 *                                   -> feature/ui (own worktree)
 * plus an untracked branch `plain`. feature/api renames, deletes, edits a
 * binary, and adds files whose names look like pathspec magic.
 */
export function makeStackFixture(options: { remote?: string } = {}): StackFixture {
  const root = tempDir("gs-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  write(root, "README.md", "# demo\n");
  write(root, "src/old.ts", "export const legacy = 1;\nexport const keep = 2;\n");
  write(root, "gone.txt", "remove me\n");
  write(root, "img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  write(root, "big.txt", `${"x".repeat(100)}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  if (options.remote) git(root, "remote", "add", "origin", options.remote);
  gt(root, "init", "--trunk", "main");

  write(root, "src/order.ts", "export type Order = { id: string };\n");
  git(root, "add", "-A");
  gt(root, "create", "feature/model", "-m", "model: order type", "--no-ai");
  write(root, "src/order.test.ts", "test('order', () => {});\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "model: order test");

  write(root, "src/checkout.ts", "export function checkout() {\n  return 1;\n}\n");
  git(root, "mv", "src/old.ts", "src/renamed.ts");
  git(root, "rm", "-q", "gone.txt");
  write(root, "img.bin", Buffer.from([0, 9, 9, 9, 0, 255, 1]));
  write(root, "src/a[1].ts", "export const bracket = 1;\n");
  write(root, "-notes.md", "dash file\n");
  write(root, "big.txt", `${"y".repeat(40_000)}\n`);
  git(root, "add", "-A");
  gt(root, "create", "feature/api", "-m", "api: checkout", "--no-ai");

  git(root, "checkout", "-q", "feature/model");
  write(root, "src/ui.tsx", "export const Ui = () => null;\n");
  git(root, "add", "-A");
  gt(root, "create", "feature/ui", "-m", "ui: screen", "--no-ai");
  git(root, "checkout", "-q", "feature/api");
  git(root, "branch", "plain", "main");

  const uiWorktree = path.join(tempDir("gs-wt-"), "ui");
  git(root, "worktree", "add", "-q", uiWorktree, "feature/ui");
  return {
    root,
    uiWorktree: realpathSync(uiWorktree),
    heads: () => {
      const out: Record<string, string> = {};
      for (const line of git(root, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads").split("\n")) {
        const [name, sha] = line.split(" ");
        if (name && sha) out[name] = sha;
      }
      return out;
    },
  };
}
