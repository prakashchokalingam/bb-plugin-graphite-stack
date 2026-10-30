// Private BB notes: anchored, persisted, never posted to a pull request.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Note } from "../contract";
import { Button } from "@/components/ui/button";
import { Chip, InlineError, Notice } from "./primitives";
import { anchorLabel, draftKey, errorMessage, relativeTime, shortSha } from "./model";
import type { GraphiteRpc } from "./rpc";
import { useTextDraft } from "./rpc";

export function NoteList({
  rpc,
  environmentId,
  notes,
  currentHeadSha,
  emptyText,
  onChanged,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  notes: Note[];
  currentHeadSha: string | null;
  emptyText?: string;
  onChanged: () => void;
}) {
  if (notes.length === 0) {
    return emptyText ? <p className="text-xs text-muted-foreground">{emptyText}</p> : null;
  }
  return (
    <ul className="flex flex-col gap-2">
      {notes.map((note) => (
        <li key={note.id}>
          <NoteCard rpc={rpc} environmentId={environmentId} note={note} currentHeadSha={currentHeadSha} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function NoteCard({
  rpc,
  environmentId,
  note,
  currentHeadSha,
  onChanged,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  note: Note;
  currentHeadSha: string | null;
  onChanged: () => void;
}) {
  const navigate = useBbNavigate();
  const replyDraft = useTextDraft(rpc, draftKey(["note-reply", note.repoKey, note.id]));
  const reply = replyDraft.value;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);

  const act = async (id: string, action: () => Promise<{ ok: boolean }>, failure: string) => {
    setBusy(id);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(failure);
      onChanged();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sendReply = async () => {
    const body = reply.trim();
    if (body === "") return;
    const ok = await act("reply", () => rpc.call("noteReply", { environmentId, noteId: note.id, body }), "The note no longer exists.");
    if (ok) await replyDraft.clear();
  };

  const fromOtherRevision = currentHeadSha !== null && note.headSha !== currentHeadSha;
  return (
    <article className={note.resolved ? "gs-comment gs-comment-resolved" : "gs-comment"} aria-label={`Comment on ${anchorLabel(note)}`}>
      <header className="gs-comment-head">
        {note.delivery ? <Chip tone="brand">{note.delivery.status === "sent" ? "Sent to thread" : note.delivery.status === "queued" ? "Queued to thread" : "Send result unknown"}</Chip> : <Chip icon="Lock">Local draft</Chip>}
        <span className="min-w-0 truncate font-mono text-[11px]" title={note.path}>
          {anchorLabel(note)}
        </span>
        {note.anchorState === "outdated" ? (
          <Chip tone="warning" title="The anchored lines changed after this note.">
            Outdated
          </Chip>
        ) : null}
        {fromOtherRevision ? (
          <Chip title={`Written on revision ${note.headSha}`}>Original {shortSha(note.headSha)}</Chip>
        ) : null}
        {note.resolved ? <Chip tone="success">Resolved locally</Chip> : null}
        {note.delivery?.hidden ? <Chip>Hidden locally</Chip> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(note.createdAt)}</span>
      </header>
      {note.lineText ? <pre className="gs-quote">{note.lineText}</pre> : null}
      {editing ? <label className="gs-field"><span>Edit local draft</span><textarea className="gs-textarea" value={body} onChange={(event) => setBody(event.target.value)} /></label> : <p className="gs-comment-body">{note.body}</p>}
      {note.replies.length > 0 ? (
        <ul className="gs-replies">
          {note.replies.map((item) => (
            <li key={item.id}>
              <p className="gs-comment-body">{item.body}</p>
              <span className="text-[10px] text-muted-foreground">{relativeTime(item.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!note.delivery ? <div className="gs-reply">
        <label className="sr-only" htmlFor={`reply-${note.id}`}>
          Reply to note
        </label>
        <textarea
          id={`reply-${note.id}`}
          className="gs-textarea"
          rows={1}
          placeholder="Reply privately"
          value={reply}
          readOnly={!replyDraft.loaded}
          onChange={(event) => replyDraft.setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void sendReply();
            }
          }}
        />
      </div> : null}
      {replyDraft.status === "error" ? <Notice>Reply draft not saved: {replyDraft.error}</Notice> : null}
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {!note.delivery ? (editing ? <><Button size="sm" disabled={busy !== null || !body.trim()} onClick={() => void act("edit", () => rpc.call("noteUpdate", { environmentId, noteId: note.id, body }), "The draft no longer exists.").then((ok) => { if (ok) setEditing(false); })}>Save</Button><Button size="sm" variant="ghost" onClick={() => { setBody(note.body); setEditing(false); }}>Cancel</Button></> : <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>) : null}
        {!note.delivery ? <Button size="sm" variant="outline" disabled={busy !== null || reply.trim() === ""} onClick={() => void sendReply()}>Reply locally</Button> : <Button size="sm" variant="outline" onClick={() => navigate.toThread(note.delivery!.threadId)}>View thread</Button>}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() =>
            void act(
              "resolve",
              () => rpc.call("noteSetResolved", { environmentId, noteId: note.id, resolved: !note.resolved }),
              "The note no longer exists.",
            )
          }
        >
          {note.resolved ? "Reopen locally" : "Resolve locally"}
        </Button>
        <span className="flex-1" />
        {note.delivery ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act("hide", () => rpc.call("noteHide", { environmentId, noteId: note.id, hidden: !note.delivery!.hidden }), "The comment no longer exists.")}>{note.delivery.hidden ? "Show locally" : "Hide locally"}</Button> : confirmDelete ? (
          <>
            <span className="text-[11px] text-muted-foreground">Delete this note and its replies?</span>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void act("delete", () => rpc.call("noteDelete", { environmentId, noteId: note.id }), "The note no longer exists.")}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
            Delete…
          </Button>
        )}
      </div>
    </article>
  );
}
