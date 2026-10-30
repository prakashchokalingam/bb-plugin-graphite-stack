import { describe, expect, it } from "vitest";
import { branchSchema, isSafeRepoPath, isValidBranchSyntax } from "../lib/model";
import {
  dropPartialRecord,
  graphitePrUrl,
  isGtVersionSupported,
  parseGithubRemote,
  parseGtState,
  parseGtVersion,
  parseNumstat,
  parseRawAndNumstat,
  parseStatusV2,
  parseWorktreeList,
  redactSecrets,
  redactUrl,
  topologyFromState,
} from "../lib/parse";

const A = "a".repeat(40);
const B = "b".repeat(40);

// Recorded from gt 1.8.6 on a disposable repo: main -> model -> {api, ui}.
const GT_186_FORK = `{
  "main": {
    "trunk": true
  },
  "feature/api": {
    "trunk": false,
    "needs_restack": false,
    "parents": [
      {
        "ref": "feature/model",
        "sha": "6e2b45b9eabced2ce665e486499b718230b76153"
      }
    ]
  },
  "feature/model": {
    "trunk": false,
    "needs_restack": true,
    "parents": [
      {
        "ref": "main",
        "sha": "d62713523b9afdc2e4438a42a8ec1505b8b4e4c5"
      }
    ]
  },
  "feature/ui": {
    "trunk": false,
    "needs_restack": false,
    "parents": [
      {
        "ref": "feature/model",
        "sha": "6e2b45b9eabced2ce665e486499b718230b76153"
      }
    ]
  }
}
`;

describe("parseGtState", () => {
  it("reads the gt 1.8.6 fork fixture with one true parent per branch", () => {
    const parsed = parseGtState(GT_186_FORK);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const topology = topologyFromState(parsed.state);
    expect(topology.trunks).toEqual(["main"]);
    const byName = Object.fromEntries(topology.branches.map((branch) => [branch.name, branch]));
    expect(byName["feature/api"]?.parent).toBe("feature/model");
    expect(byName["feature/ui"]?.parent).toBe("feature/model");
    expect(byName["feature/model"]?.parent).toBe("main");
    expect(byName["feature/model"]?.needsRestack).toBe(true);
    expect(byName.main?.parent).toBeNull();
  });

  it("skips tips that gt prints before the JSON document", () => {
    const parsed = parseGtState(`Graphite has not been initialized...\n\ntip: something {not json}\n\n${GT_186_FORK}`);
    expect(parsed.ok).toBe(true);
  });

  it.each(["09-12-fix_workflow_message_409", "constructor", "toString", "__proto__"])("preserves missing parent %s without traversing inherited properties", (parent) => {
    const parsed = parseGtState(JSON.stringify({ main: { trunk: true }, child: { trunk: false, parents: [{ ref: parent, sha: A }] }, grandchild: { trunk: false, parents: [{ ref: "child", sha: B }] } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const topology = topologyFromState(parsed.state);
    expect(topology.branches.find((branch) => branch.name === "child")?.parent).toBe(parent);
    expect(topology.branches.map((branch) => branch.name)).toEqual(["main", "child", "grandchild"]);
    expect(topology.trunks).toEqual(["main"]);
    expect(Object.hasOwn(parsed.state, parent)).toBe(false);
  });

  it("accepts multiple trunks", () => {
    const parsed = parseGtState(JSON.stringify({ main: { trunk: true }, release: { trunk: true }, fix: { trunk: false, parents: [{ ref: "release", sha: A }] } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(topologyFromState(parsed.state).trunks.sort()).toEqual(["main", "release"]);
  });

  it.each([
    ["no JSON", "ERROR: You must run this command from within a git repository."],
    ["malformed JSON", "{ \"main\": { \"trunk\": true }"],
    ["unsupported shape", JSON.stringify({ main: { trunk: "yes" } })],
    ["no trunk", JSON.stringify({ a: { trunk: false, parents: [{ ref: "b", sha: A }] }, b: { trunk: false, parents: [{ ref: "a", sha: B }] } })],
    ["self parent", JSON.stringify({ main: { trunk: true }, x: { trunk: false, parents: [{ ref: "x", sha: A }] } })],
    ["cycle", JSON.stringify({ main: { trunk: true }, x: { trunk: false, parents: [{ ref: "y", sha: A }] }, y: { trunk: false, parents: [{ ref: "x", sha: B }] } })],
    ["two parents", JSON.stringify({ main: { trunk: true }, x: { trunk: false, parents: [{ ref: "main", sha: A }, { ref: "main", sha: B }] } })],
    ["no parent", JSON.stringify({ main: { trunk: true }, x: { trunk: false } })],
    ["short sha", JSON.stringify({ main: { trunk: true }, x: { trunk: false, parents: [{ ref: "main", sha: "abc" }] } })],
  ])("rejects %s", (_name, text) => {
    expect(parseGtState(text).ok).toBe(false);
  });
});

describe("gt version", () => {
  it("parses and gates versions", () => {
    expect(parseGtVersion("1.8.6\n")).toBe("1.8.6");
    expect(isGtVersionSupported("1.8.6")).toBe(true);
    expect(isGtVersionSupported("1.9.0")).toBe(true);
    expect(isGtVersionSupported("1.7.9")).toBe(false);
    expect(isGtVersionSupported("2.0.0")).toBe(false);
    expect(isGtVersionSupported(null)).toBe(false);
  });
});

describe("branch and path validation", () => {
  it.each(["main", "feature/api", "fix/café", "fix@home", "user/123_x-y.z", "a+b#c"])("accepts %s", (name) => {
    expect(isValidBranchSyntax(name)).toBe(true);
    expect(branchSchema.safeParse(name).success).toBe(true);
  });
  it.each(["-x", "--force", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a//b", ".a", "a/.b", "a.lock", "a.", "@", "a@{1}", "", "HEAD", "a\u0007"])(
    "rejects %j",
    (name) => {
      expect(isValidBranchSyntax(name)).toBe(false);
    },
  );
  it("accepts literal file names and rejects escapes", () => {
    expect(isSafeRepoPath("-notes.md")).toBe(true);
    expect(isSafeRepoPath("src/a[1].ts")).toBe(true);
    expect(isSafeRepoPath(":(glob)**")).toBe(true);
    expect(isSafeRepoPath("../etc/passwd")).toBe(false);
    expect(isSafeRepoPath("a/../../b")).toBe(false);
    expect(isSafeRepoPath("/abs")).toBe(false);
    expect(isSafeRepoPath("a\0b")).toBe(false);
    expect(isSafeRepoPath("a//b")).toBe(false);
  });
});

describe("git parsers", () => {
  it("parses worktree list -z", () => {
    const out = `worktree /r\0HEAD ${A}\0branch refs/heads/main\0\0worktree /r-wt\0HEAD ${B}\0detached\0\0worktree /bare\0bare\0\0`;
    expect(parseWorktreeList(out)).toEqual([
      { path: "/r", headSha: A, branch: "main", detached: false, bare: false },
      { path: "/r-wt", headSha: B, branch: null, detached: true, bare: false },
      { path: "/bare", headSha: null, branch: null, detached: false, bare: true },
    ]);
  });

  it("parses status v2 with renames, conflicts, and untracked files", () => {
    const out = [
      `# branch.oid ${A}`,
      "# branch.head feature/api",
      "1 M. N... 100644 100644 100644 x y src/a b.ts",
      ".",
      "2 R. N... 100644 100644 100644 x y R100 new.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 x y z conflict.ts",
      "? notes.txt",
      "",
    ].join("\0");
    const parsed = parseStatusV2(out.replace("\0.\0", "\0"));
    expect(parsed.branch).toBe("feature/api");
    expect(parsed.headSha).toBe(A);
    expect(parsed.staged).toBe(2);
    expect(parsed.unstaged).toBe(0);
    expect(parsed.conflicted).toBe(1);
    expect(parsed.untracked).toBe(1);
    expect(parsed.files.map((file) => [file.path, file.oldPath])).toEqual([
      ["src/a b.ts", null],
      ["new.ts", "old.ts"],
      ["conflict.ts", null],
      ["notes.txt", null],
    ]);
  });

  it("joins raw and numstat for renames, binaries, and deletions", () => {
    const z = "0".repeat(40);
    const raw = [
      `:100644 100644 ${A} ${B} R087`,
      "src/old.ts",
      "src/new.ts",
      `:000000 100644 ${z} ${B} A`,
      "img.png",
      `:100644 000000 ${A} ${z} D`,
      "gone.txt",
      "",
    ].join("\0");
    const numstat = ["3\t1\t", "src/old.ts", "src/new.ts", "-\t-\timg.png", "0\t4\tgone.txt", ""].join("\0");
    const files = parseRawAndNumstat(raw, numstat);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: "src/new.ts", oldPath: "src/old.ts", status: "R", similarity: 87, additions: 3, deletions: 1 });
    expect(files[1]).toMatchObject({ path: "img.png", status: "A", binary: true, additions: null });
    expect(files[2]).toMatchObject({ path: "gone.txt", status: "D", deletions: 4 });
    expect(parseNumstat("")).toEqual(new Map());
  });

  it("drops a partial trailing record from capped output", () => {
    expect(dropPartialRecord("a\0b\0par", true)).toBe("a\0b\0");
    expect(dropPartialRecord("a\0b\0par", false)).toBe("a\0b\0par");
    expect(dropPartialRecord("partial", true)).toBe("");
  });
});

describe("remotes and redaction", () => {
  it.each([
    ["https://github.com/acme/demo.git", "acme", "demo"],
    ["https://x-token:secret@github.com/acme/demo", "acme", "demo"],
    ["git@github.com:acme/demo.git", "acme", "demo"],
    ["ssh://git@github.com/acme/demo.git", "acme", "demo"],
    ["https://corp.ghe.com/acme/demo.git", "acme", "demo"],
  ])("parses %s", (url, owner, repo) => {
    const remote = parseGithubRemote("origin", url);
    expect(remote).toMatchObject({ owner, repo });
    expect(remote?.url).not.toContain("secret");
  });

  it.each([
    "https://github.evil.example/acme/demo.git",
    "https://gitlab.com/acme/demo.git",
    "https://github.com/../demo.git",
    "https://github.com/acme/..",
    "https://github.com/./demo",
    "/local/path/repo.git",
  ])("rejects %s", (url) => {
    expect(parseGithubRemote("origin", url)).toBeNull();
  });

  it("redacts user info for every scheme and common tokens", () => {
    expect(redactUrl("ssh://user:pw@github.com/o/r.git")).toBe("ssh://github.com/o/r.git");
    expect(redactUrl("https://tok@github.com/o/r")).toBe("https://github.com/o/r");
    const fakeToken = `ghp_${"x".repeat(36)}`;
    const text = redactSecrets(`fatal: https://u:p@github.com/o/r failed with ${fakeToken}\nAuthorization: Bearer abc.def`);
    expect(text).not.toContain("u:p@");
    expect(text).not.toContain(fakeToken);
    expect(text).not.toContain("abc.def");
  });

  it("builds canonical Graphite PR links", () => {
    expect(graphitePrUrl("acme", "demo", 12)).toBe("https://app.graphite.com/github/pr/acme/demo/12");
  });
});
