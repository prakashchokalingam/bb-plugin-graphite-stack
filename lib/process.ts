// Bounded process execution for the host entry. Every call uses an argument
// array (no shell), a timeout, and a byte cap per output stream.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { experimental_sanitizeInheritedChildProcessEnv as sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Byte cap for stdout. Output past the cap is dropped and `truncated` is set. */
  maxBytes?: number;
  input?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  truncated: boolean;
  timedOut: boolean;
  /** Spawn failed, e.g. the binary is missing. */
  spawnError: string | null;
  argv: string[];
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;

/** Environment for non-interactive tools. Never prompt, never page, no color. */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CLICOLOR: "0",
  TERM: "dumb",
  LC_ALL: "C",
  SSH_ASKPASS_REQUIRE: "never",
};

/** Appended to PATH when absent, so Homebrew-installed gt and gh resolve. */
const FALLBACK_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/**
 * The host worker already receives the user's normalized PATH. The SDK
 * helper removes daemon-owned variables before a child inherits them.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv;
  try {
    env = sanitizeInheritedChildProcessEnv({ env: process.env });
  } catch {
    env = { ...process.env };
  }
  if (process.platform !== "win32") {
    const parts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const fallback of FALLBACK_PATHS) if (!parts.includes(fallback)) parts.push(fallback);
    env.PATH = parts.join(path.delimiter);
  }
  return env;
}

function resolveCommand(command: string, args: readonly string[]) {
  return { command, args: [...args], env: childEnvironment() };
}

const KILL_GRACE_MS = 2000;
/** After a kill, resolve even if a grandchild still holds the pipes. */
const SETTLE_AFTER_KILL_MS = 5000;

export const runProcess: Runner = (command, args, options) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const argv = [command, ...args];
  const failed = (spawnError: string, timedOut = false): RunResult => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    truncated: false,
    timedOut,
    spawnError,
    argv,
  });
  if (options.signal?.aborted) return Promise.resolve(failed("Cancelled before start", true));
  return new Promise<RunResult>((resolve) => {
    const resolved = resolveCommand(command, args);
    const posix = process.platform !== "win32";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        env: { ...resolved.env, ...NON_INTERACTIVE_ENV, ...(options.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        // Own process group and session: no controlling terminal, so ssh and
        // credential helpers cannot prompt, and a kill reaches grandchildren.
        detached: posix,
      });
    } catch (error) {
      resolve(failed(error instanceof Error ? error.message : String(error)));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let keptStdout = 0;
    let keptStderr = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;
    let settleTimer: NodeJS.Timeout | null = null;

    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer !== null) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutBytes,
        truncated,
        timedOut,
        spawnError,
        argv,
      });
    };
    const kill = () => {
      timedOut = true;
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
      settleTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, SETTLE_AFTER_KILL_MS);
      settleTimer.unref();
    };
    const timer = setTimeout(kill, timeoutMs);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) kill();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (keptStdout >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - keptStdout;
      if (chunk.length > room) {
        stdoutChunks.push(chunk.subarray(0, room));
        keptStdout += room;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        keptStdout += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (keptStderr >= STDERR_MAX_BYTES) return;
      const part = chunk.subarray(0, STDERR_MAX_BYTES - keptStderr);
      stderrChunks.push(part);
      keptStderr += part.length;
    });
    child.on("error", (error) => {
      spawnError = error.message;
      // A spawn failure emits no "close" when the process never started.
      if (child.pid === undefined) finish(null);
    });
    child.stdin.on("error", () => {
      // The child may exit before it reads stdin.
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    child.on("close", (code) => finish(code));
  });
};

/** A runner that passes one abort signal to every call. */
export function withSignal(run: Runner, signal: AbortSignal): Runner {
  return (command, args, options) => run(command, args, { ...options, signal: options.signal ?? signal });
}

/** Last `max` characters of text, for operation logs. */
export function tail(text: string, max = 8000): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/** Remove ANSI escapes from tool output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}
