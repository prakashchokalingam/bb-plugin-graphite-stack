// Private BB notes: anchored, persisted, never posted to a pull request.
import { useEffect, useRef, useState } from "react";
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
  inline = false,
  selectedIds,
  onSelect,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  notes: Note[];
  currentHeadSha: string | null;
  emptyText?: string;
  onChanged: () => void;
  inline?: boolean;
  selectedIds?: string[];
  onSelect?: (id: string, checked: boolean) => void;
}) {
  if (notes.length === 0) {
    return emptyText ? <p className="text-xs text-muted-foreground">{emptyText}</p> : null;
  }
  return (
    <ul className="flex flex-col gap-2">
      {notes.map((note) => (
        <li key={note.id}>
          <NoteCard rpc={rpc} environmentId={environmentId} note={note} currentHeadSha={currentHeadSha} onChanged={onChanged} inline={inline} selected={selectedIds?.includes(note.id) ?? false} onSelect={onSelect} />
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
  inline,
  selected,
  onSelect,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  note: Note;
  currentHeadSha: string | null;
  onChanged: () => void;
  inline: boolean;
  selected: boolean;
  onSelect?: (id: string, checked: boolean) => void;
}) {
  const navigate = useBbNavigate();
  const replyDraft = useTextDraft(rpc, draftKey(["note-reply", note.repoKey, note.id]));
  const reply = replyDraft.value;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const replyRestored = useRef(false);
  useEffect(() => {
    if (replyDraft.loaded && !replyRestored.current) {
      replyRestored.current = true;
      if (replyDraft.value.trim()) setReplyOpen(true);
    }
  }, [replyDraft.loaded, replyDraft.value]);
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
  const checkDelivery = async () => {
    setBusy("check"); setError(null);
    try {
      const result = await rpc.call("noteReconcile", { environmentId, noteId: note.id });
      if (result.status === "unknown") setError("Delivery is still unknown. Check the destination thread before sending again.");
      onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  };

  const fromOtherRevision = currentHeadSha !== null && note.headSha !== currentHeadSha;
  if (deleting) return null;
  return (
    <article className={note.resolved ? "gs-comment gs-comment-resolved" : "gs-comment"} aria-label={`Comment on ${anchorLabel(note)}`}>
      <header className="gs-comment-head">
        {onSelect && !note.resolved && !note.delivery ? <input type="checkbox" aria-label={`Select ${note.body}`} checked={selected} onChange={(event) => onSelect(note.id, event.target.checked)} /> : null}
        {note.delivery ? <Chip tone="brand">{note.delivery.status === "sent" ? "Sent to thread" : note.delivery.status === "queued" ? "Queued to thread" : "Send result unknown"}</Chip> : <Chip icon="Lock">Local draft</Chip>}
        {!inline ? <span className="min-w-0 truncate font-mono text-[11px]" title={note.path}>
          {anchorLabel(note)}
        </span> : null}
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
      {!inline && note.lineText ? <pre className="gs-quote">{note.lineText}</pre> : null}
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
      {!note.delivery && replyOpen ? <div className="gs-reply">
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
        <div className="flex gap-1"><Button size="sm" disabled={busy !== null || reply.trim() === ""} onClick={() => void sendReply()}>Reply locally</Button><Button size="sm" variant="ghost" onClick={() => setReplyOpen(false)}>Close</Button></div>
      </div> : null}
      {replyDraft.status === "error" ? <Notice>Reply draft not saved: {replyDraft.error}</Notice> : null}
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {!note.delivery ? <IconAction label="Reply locally" glyph="reply" disabled={busy !== null} onClick={() => setReplyOpen((value) => !value)} /> : <IconAction label="View thread" glyph="external" onClick={() => navigate.toThread(note.delivery!.threadId)} />}
        {note.delivery?.status === "unknown" ? <IconAction label="Check delivery" glyph="reopen" disabled={busy !== null} onClick={() => void checkDelivery()} /> : null}
        {!note.delivery ? (editing ? <><Button size="sm" disabled={busy !== null || !body.trim()} onClick={() => void act("edit", () => rpc.call("noteUpdate", { environmentId, noteId: note.id, body }), "The draft no longer exists.").then((ok) => { if (ok) setEditing(false); })}>Save</Button><Button size="sm" variant="ghost" onClick={() => { setBody(note.body); setEditing(false); }}>Cancel</Button></> : <IconAction label="Edit" glyph="edit" onClick={() => setEditing(true)} />) : null}
        <IconAction
          label={note.resolved ? "Reopen locally" : "Resolve locally"}
          glyph={note.resolved ? "reopen" : "check"}
          disabled={busy !== null}
          onClick={() =>
            void act(
              "resolve",
              () => rpc.call("noteSetResolved", { environmentId, noteId: note.id, resolved: !note.resolved }),
              "The note no longer exists.",
            )
          }
        />
        <span className="flex-1" />
        {note.delivery ? <IconAction label={note.delivery.hidden ? "Show locally" : "Hide locally"} glyph="hide" disabled={busy !== null} onClick={() => void act("hide", () => rpc.call("noteHide", { environmentId, noteId: note.id, hidden: !note.delivery!.hidden }), "The comment no longer exists.")} /> : confirmDelete ? (
          <>
            <span className="text-[11px] text-muted-foreground">Delete this note and its replies?</span>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => { setDeleting(true); void act("delete", () => rpc.call("noteDelete", { environmentId, noteId: note.id }), "The note no longer exists.").then((ok) => { if (!ok) { setDeleting(false); setConfirmDelete(false); } }); }}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <IconAction label="Delete" glyph="trash" disabled={busy !== null} onClick={() => setConfirmDelete(true)} />
        )}
      </div>
    </article>
  );
}

function IconAction({ label, glyph, onClick, disabled }: { label: string; glyph: "reply" | "edit" | "check" | "reopen" | "trash" | "external" | "hide"; onClick: () => void; disabled?: boolean }) {
  const paths: Record<typeof glyph, string> = { reply: "M9 10 5 6l4-4M5 6h8a5 5 0 0 1 5 5v2", edit: "M3 15l1-4L13 2l3 3-9 9-4 1zM11 4l3 3", check: "M3 9l4 4 8-9", reopen: "M4 4v4h4M4 8a6 6 0 1 1 1 5", trash: "M4 5h12M7 5V3h6v2M6 5l1 11h6l1-11M9 8v5m3-5v5", external: "M10 3h6v6M16 3 8 11M14 11v5H3V5h5", hide: "M2 9s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5zm5 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0z" };
  return <button type="button" className="gs-comment-action" aria-label={label} data-tooltip={label} disabled={disabled} onClick={onClick}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[glyph]} /></svg></button>;
}
