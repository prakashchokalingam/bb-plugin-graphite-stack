import { useEffect, useState } from "react";
import type { Note } from "../contract";
import { Button } from "@/components/ui/button";
import { InlineError, Notice } from "./primitives";
import type { GraphiteRpc } from "./rpc";

export function ThreadReview({ rpc, environmentId, branch, threadId, notes, onChanged }: {
  rpc: GraphiteRpc; environmentId: string; branch: string; threadId: string | null; notes: Note[]; onChanged: () => void;
}) {
  const drafts = notes.filter((note) => !note.resolved && !note.delivery);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSelected((old) => old.filter((id) => drafts.some((note) => note.id === id))), [notes]);
  if (drafts.length === 0 && !message) return null;
  const chosen = drafts.filter((note) => selected.includes(note.id));
  const send = async () => {
    if (!threadId || !chosen.length || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await rpc.call("notesSend", { environmentId, branch, threadId, noteIds: chosen.map((note) => note.id) });
      setMessage(result.status === "sent" ? "Sent to the linked thread." : result.status === "queued" ? "Queued to the linked thread." : result.message);
      setPreview(false); setSelected([]); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="gs-thread-review" aria-label="Send local drafts">
    <h3 className="gs-subhead">Local drafts · {drafts.length}</h3>
    {!threadId ? <Notice>Link this branch to a BB thread before sending.</Notice> : null}
    {drafts.map((note) => <label key={note.id} className="gs-review-select">
      <input type="checkbox" checked={selected.includes(note.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, note.id] : old.filter((id) => id !== note.id))} />
      <span><strong>{note.path} · {note.side} {note.startLine}{note.endLine === note.startLine ? "" : `–${note.endLine}`}</strong><br />{note.body}{note.anchorState !== "current" ? " · Lines need review" : ""}</span>
    </label>)}
    {error ? <InlineError>{error}</InlineError> : null}{message ? <Notice>{message}</Notice> : null}
    {preview ? <div className="gs-review-preview"><strong>Message to linked thread</strong>
      <p className="text-xs text-muted-foreground">Sending starts a turn or queues the message if the thread is active.</p>
      {chosen.map((note) => <div key={note.id} className="gs-review-preview-item"><strong>{note.path} · {note.side} {note.startLine}{note.endLine === note.startLine ? "" : `–${note.endLine}`}</strong><pre className="gs-quote">{note.lineText}</pre><p>{note.body}</p>{note.replies.map((reply) => <p key={reply.id}>Reply: {reply.body}</p>)}</div>)}
      <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(false)}>Back</Button><Button size="sm" disabled={busy || chosen.some((note) => note.anchorState !== "current")} onClick={() => void send()}>{busy ? "Sending…" : `Send ${chosen.length} ${chosen.length === 1 ? "comment" : "comments"}`}</Button></div>
    </div> : <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setSelected(drafts.map((note) => note.id))}>Select all</Button><Button size="sm" disabled={!threadId || !chosen.length} onClick={() => setPreview(true)}>Review message · {chosen.length}</Button></div>}
  </section>;
}
