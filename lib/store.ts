// Plugin-owned persistence in the plugin SQLite database: thread links,
// private notes, viewed files, pending PR reviews, and the operation journal.
// Nothing here is Graphite metadata and nothing here is sent to GitHub except
// pending review comments on an explicit submit.
import { randomUUID } from "node:crypto";
import type { OperationResult, PendingReview } from "../contract";

/** The subset of better-sqlite3 the store needs. */
export interface Db {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS links (
    repo_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    environment_id TEXT,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (repo_key, branch)
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    line_text TEXT NOT NULL,
    body TEXT NOT NULL,
    thread_id TEXT,
    parent_id TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS notes_branch ON notes (repo_key, branch)`,
  `CREATE TABLE IF NOT EXISTS viewed (
    repo_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    file_key TEXT NOT NULL,
    PRIMARY KEY (repo_key, branch, path)
  )`,
  `CREATE TABLE IF NOT EXISTS pending_reviews (
    repo_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    submission TEXT,
    last_error TEXT,
    PRIMARY KEY (repo_key, branch)
  )`,
  `CREATE TABLE IF NOT EXISTS pending_comments (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    side TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    line_text TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    finished_at INTEGER NOT NULL,
    result TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS operations_repo ON operations (repo_key, finished_at)`,
  `CREATE TABLE IF NOT EXISTS note_deliveries (
    note_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, batch_id TEXT NOT NULL,
    status TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
  )`,
];

export interface LinkRow {
  repoKey: string;
  branch: string;
  threadId: string;
  environmentId: string | null;
  linkedAt: number;
}

export interface NoteRow {
  id: string;
  repoKey: string;
  branch: string;
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  baseSha: string;
  headSha: string;
  lineText: string;
  body: string;
  threadId: string | null;
  parentId: string | null;
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PendingCommentRow {
  id: string;
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  baseSha: string;
  headSha: string;
  lineText: string;
  body: string;
  createdAt: number;
}

type Raw = Record<string, unknown>;
const str = (row: Raw, key: string) => String(row[key] ?? "");
const num = (row: Raw, key: string) => Number(row[key] ?? 0);
const nstr = (row: Raw, key: string) => (row[key] === null || row[key] === undefined ? null : String(row[key]));

function toNote(row: Raw): NoteRow {
  return {
    id: str(row, "id"),
    repoKey: str(row, "repo_key"),
    branch: str(row, "branch"),
    path: str(row, "path"),
    side: str(row, "side") === "old" ? "old" : "new",
    startLine: num(row, "start_line"),
    endLine: num(row, "end_line"),
    baseSha: str(row, "base_sha"),
    headSha: str(row, "head_sha"),
    lineText: str(row, "line_text"),
    body: str(row, "body"),
    threadId: nstr(row, "thread_id"),
    parentId: nstr(row, "parent_id"),
    resolved: num(row, "resolved") === 1,
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

function toPendingComment(row: Raw): PendingCommentRow {
  return {
    id: str(row, "id"),
    path: str(row, "path"),
    side: str(row, "side") === "old" ? "old" : "new",
    startLine: num(row, "start_line"),
    endLine: num(row, "end_line"),
    baseSha: str(row, "base_sha"),
    headSha: str(row, "head_sha"),
    lineText: str(row, "line_text"),
    body: str(row, "body"),
    createdAt: num(row, "created_at"),
  };
}

export const MAX_NOTES_PER_BRANCH = 1000;
export const MAX_PENDING_COMMENTS = 200;
export const MAX_OPERATIONS_PER_REPO = 50;

export interface PendingState {
  prNumber: number;
  body: string;
  submission: PendingReview["submission"];
  lastError: string | null;
  comments: PendingCommentRow[];
}

export function createStore(db: Db, now: () => number = Date.now) {
  return {
    // Links ---------------------------------------------------------------
    getLink(repoKey: string, branch: string): LinkRow | null {
      const row = db.prepare("SELECT * FROM links WHERE repo_key = ? AND branch = ?").get(repoKey, branch) as Raw | undefined;
      if (row === undefined) return null;
      return {
        repoKey,
        branch,
        threadId: str(row, "thread_id"),
        environmentId: nstr(row, "environment_id"),
        linkedAt: num(row, "linked_at"),
      };
    },
    listLinks(repoKey: string): LinkRow[] {
      return (db.prepare("SELECT * FROM links WHERE repo_key = ?").all(repoKey) as Raw[]).map((row) => ({
        repoKey,
        branch: str(row, "branch"),
        threadId: str(row, "thread_id"),
        environmentId: nstr(row, "environment_id"),
        linkedAt: num(row, "linked_at"),
      }));
    },
    setLink(repoKey: string, branch: string, threadId: string, environmentId: string | null): LinkRow {
      const linkedAt = now();
      db.prepare(
        `INSERT INTO links (repo_key, branch, thread_id, environment_id, linked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo_key, branch) DO UPDATE SET thread_id = excluded.thread_id,
           environment_id = excluded.environment_id, linked_at = excluded.linked_at`,
      ).run(repoKey, branch, threadId, environmentId, linkedAt);
      return { repoKey, branch, threadId, environmentId, linkedAt };
    },
    deleteLink(repoKey: string, branch: string): boolean {
      return db.prepare("DELETE FROM links WHERE repo_key = ? AND branch = ?").run(repoKey, branch).changes > 0;
    },

    // Notes ---------------------------------------------------------------
    listNotes(repoKey: string, branch: string): NoteRow[] {
      return (
        db
          .prepare("SELECT * FROM notes WHERE repo_key = ? AND branch = ? ORDER BY created_at ASC LIMIT ?")
          .all(repoKey, branch, MAX_NOTES_PER_BRANCH) as Raw[]
      ).map(toNote);
    },
    getNote(id: string): NoteRow | null {
      const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Raw | undefined;
      return row === undefined ? null : toNote(row);
    },
    countNotes(repoKey: string, branch: string): number {
      const row = db.prepare("SELECT count(*) AS n FROM notes WHERE repo_key = ? AND branch = ?").get(repoKey, branch) as Raw;
      return num(row, "n");
    },
    createNote(input: Omit<NoteRow, "id" | "createdAt" | "updatedAt" | "resolved">): NoteRow {
      const id = randomUUID();
      const time = now();
      db.prepare(
        `INSERT INTO notes (id, repo_key, branch, path, side, start_line, end_line, base_sha, head_sha, line_text,
           body, thread_id, parent_id, resolved, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        id,
        input.repoKey,
        input.branch,
        input.path,
        input.side,
        input.startLine,
        input.endLine,
        input.baseSha,
        input.headSha,
        input.lineText,
        input.body,
        input.threadId,
        input.parentId,
        time,
        time,
      );
      return { ...input, id, resolved: false, createdAt: time, updatedAt: time };
    },
    setNoteResolved(id: string, resolved: boolean): boolean {
      return db.prepare("UPDATE notes SET resolved = ?, updated_at = ? WHERE id = ? AND parent_id IS NULL").run(resolved ? 1 : 0, now(), id).changes > 0;
    },
    deleteNote(id: string): boolean {
      const remove = db.transaction((noteId: string) => {
        db.prepare("DELETE FROM notes WHERE parent_id = ?").run(noteId);
        return db.prepare("DELETE FROM notes WHERE id = ?").run(noteId).changes > 0;
      });
      return remove(id);
    },

    getNoteDelivery(id: string): { threadId: string; batchId: string; status: "sending" | "sent" | "queued" | "unknown"; hidden: boolean } | null {
      const row = db.prepare("SELECT * FROM note_deliveries WHERE note_id = ?").get(id) as Raw | undefined;
      if (!row) return null;
      const status = str(row, "status");
      return { threadId: str(row, "thread_id"), batchId: str(row, "batch_id"), status: status === "sent" || status === "queued" || status === "sending" ? status : "unknown", hidden: num(row, "hidden") === 1 };
    },
    beginNoteDelivery(ids: string[], threadId: string, batchId: string): void {
      db.transaction(() => {
        for (const id of ids) db.prepare("INSERT INTO note_deliveries (note_id, thread_id, batch_id, status) VALUES (?, ?, ?, 'sending')").run(id, threadId, batchId);
      })();
    },
    finishNoteDelivery(batchId: string, status: "sent" | "queued" | "unknown"): void {
      db.prepare("UPDATE note_deliveries SET status = ? WHERE batch_id = ?").run(status, batchId);
    },
    hideNote(id: string, hidden: boolean): boolean {
      return db.prepare("UPDATE note_deliveries SET hidden = ? WHERE note_id = ?").run(hidden ? 1 : 0, id).changes > 0;
    },
    updateNote(id: string, body: string): boolean {
      return db.prepare("UPDATE notes SET body = ?, updated_at = ? WHERE id = ? AND parent_id IS NULL").run(body, now(), id).changes > 0;
    },

    // Viewed ---------------------------------------------------------------
    listViewed(repoKey: string, branch: string): { path: string; fileKey: string }[] {
      return (db.prepare("SELECT path, file_key FROM viewed WHERE repo_key = ? AND branch = ?").all(repoKey, branch) as Raw[]).map(
        (row) => ({ path: str(row, "path"), fileKey: str(row, "file_key") }),
      );
    },
    setViewed(repoKey: string, branch: string, path: string, fileKey: string, viewed: boolean): void {
      if (viewed) {
        db.prepare(
          `INSERT INTO viewed (repo_key, branch, path, file_key) VALUES (?, ?, ?, ?)
           ON CONFLICT (repo_key, branch, path) DO UPDATE SET file_key = excluded.file_key`,
        ).run(repoKey, branch, path, fileKey);
      } else {
        db.prepare("DELETE FROM viewed WHERE repo_key = ? AND branch = ? AND path = ?").run(repoKey, branch, path);
      }
    },

    // Pending PR reviews ---------------------------------------------------
    getPending(repoKey: string, branch: string): PendingState | null {
      const row = db.prepare("SELECT * FROM pending_reviews WHERE repo_key = ? AND branch = ?").get(repoKey, branch) as Raw | undefined;
      if (row === undefined) return null;
      const comments = (
        db
          .prepare("SELECT * FROM pending_comments WHERE repo_key = ? AND branch = ? ORDER BY created_at ASC")
          .all(repoKey, branch) as Raw[]
      ).map(toPendingComment);
      let submission: PendingReview["submission"] = null;
      const rawSubmission = nstr(row, "submission");
      if (rawSubmission !== null) {
        try {
          submission = JSON.parse(rawSubmission) as PendingReview["submission"];
        } catch {
          submission = null;
        }
      }
      return {
        prNumber: num(row, "pr_number"),
        body: str(row, "body"),
        submission,
        lastError: nstr(row, "last_error"),
        comments,
      };
    },
    ensurePending(repoKey: string, branch: string, prNumber: number): void {
      const existing = db.prepare("SELECT pr_number FROM pending_reviews WHERE repo_key = ? AND branch = ?").get(repoKey, branch) as Raw | undefined;
      if (existing !== undefined && num(existing, "pr_number") !== prNumber) {
        throw new Error(`A pending review for PR #${num(existing, "pr_number")} exists on this branch. Submit or discard it first.`);
      }
      db.prepare(
        `INSERT INTO pending_reviews (repo_key, branch, pr_number) VALUES (?, ?, ?) ON CONFLICT (repo_key, branch) DO NOTHING`,
      ).run(repoKey, branch, prNumber);
    },
    addPendingComment(repoKey: string, branch: string, comment: Omit<PendingCommentRow, "id" | "createdAt">): PendingCommentRow {
      const count = num(
        db.prepare("SELECT count(*) AS n FROM pending_comments WHERE repo_key = ? AND branch = ?").get(repoKey, branch) as Raw,
        "n",
      );
      if (count >= MAX_PENDING_COMMENTS) throw new Error(`A pending review holds at most ${MAX_PENDING_COMMENTS} comments`);
      const row: PendingCommentRow = { ...comment, id: randomUUID(), createdAt: now() };
      db.prepare(
        `INSERT INTO pending_comments (id, repo_key, branch, path, side, start_line, end_line, base_sha, head_sha, line_text, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        repoKey,
        branch,
        row.path,
        row.side,
        row.startLine,
        row.endLine,
        row.baseSha,
        row.headSha,
        row.lineText,
        row.body,
        row.createdAt,
      );
      return row;
    },
    removePendingComment(repoKey: string, branch: string, id: string): boolean {
      return db.prepare("DELETE FROM pending_comments WHERE repo_key = ? AND branch = ? AND id = ?").run(repoKey, branch, id).changes > 0;
    },
    setPendingBody(repoKey: string, branch: string, body: string): void {
      db.prepare("UPDATE pending_reviews SET body = ? WHERE repo_key = ? AND branch = ?").run(body, repoKey, branch);
    },
    setPendingSubmission(repoKey: string, branch: string, submission: PendingReview["submission"], lastError: string | null): void {
      db.prepare("UPDATE pending_reviews SET submission = ?, last_error = ? WHERE repo_key = ? AND branch = ?").run(
        submission === null ? null : JSON.stringify(submission),
        lastError,
        repoKey,
        branch,
      );
    },
    clearPending(repoKey: string, branch: string): void {
      const clear = db.transaction(() => {
        db.prepare("DELETE FROM pending_comments WHERE repo_key = ? AND branch = ?").run(repoKey, branch);
        db.prepare("DELETE FROM pending_reviews WHERE repo_key = ? AND branch = ?").run(repoKey, branch);
      });
      clear();
    },

    // Operation journal -----------------------------------------------------
    recordOperation(repoKey: string, result: OperationResult): void {
      db.prepare("INSERT INTO operations (id, repo_key, finished_at, result) VALUES (?, ?, ?, ?)").run(
        result.id,
        repoKey,
        result.finishedAt,
        JSON.stringify(result),
      );
      db.prepare(
        `DELETE FROM operations WHERE repo_key = ? AND id NOT IN (
           SELECT id FROM operations WHERE repo_key = ? ORDER BY finished_at DESC LIMIT ?)`,
      ).run(repoKey, repoKey, MAX_OPERATIONS_PER_REPO);
    },
    lastOperation(repoKey: string): OperationResult | null {
      const row = db.prepare("SELECT result FROM operations WHERE repo_key = ? ORDER BY finished_at DESC LIMIT 1").get(repoKey) as Raw | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(str(row, "result")) as OperationResult;
      } catch {
        return null;
      }
    },
  };
}

export type Store = ReturnType<typeof createStore>;
