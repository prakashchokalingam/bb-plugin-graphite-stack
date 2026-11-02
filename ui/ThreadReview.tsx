import { useEffect, useMemo, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { Note, ThreadSummary } from "../contract";
import { Button } from "@/components/ui/button";
import { InlineError, Notice } from "./primitives";
import { NoteList } from "./Notes";
import type { GraphiteRpc } from "./rpc";

export function ThreadReview({ rpc, environmentId, branch, currentThreadId, linkedThread, candidates, notes, visibleNotes, currentHeadSha, emptyText, onChanged }: {
  rpc: GraphiteRpc; environmentId: string; branch: string; currentThreadId: string | null;
  linkedThread: ThreadSummary | null; candidates: ThreadSummary[]; notes: Note[]; visibleNotes: Note[];
  currentHeadSha: string | null; emptyText?: string; onChanged: () => void;
}) {
  const sdk = useSdk();
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [destination, setDestination] = useState(currentThreadId ?? linkedThread?.id ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenDrafts = useRef(new Set<string>());
  const drafts = notes.filter((note) => !note.resolved && !note.delivery);
  const choices = useMemo(() => [...new Map([...(linkedThread ? [linkedThread] : []), ...candidates].filter((thread) => !thread.archived).map((thread) => [thread.id, thread])).values()], [linkedThread, candidates]);
  useEffect(() => {
    let cancelled = false;
    setCurrentTitle(null);
    if (currentThreadId) void Promise.resolve().then(() => sdk.threads.get({ threadId: currentThreadId })).then((thread) => { if (!cancelled) setCurrentTitle(thread.title ?? thread.titleFallback ?? null); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sdk, currentThreadId]);
  useEffect(() => {
    const nextIds = drafts.map((note) => note.id);
    const added = nextIds.filter((id) => !seenDrafts.current.has(id));
    for (const id of added) seenDrafts.current.add(id);
    setSelected((old) => [...old.filter((id) => nextIds.includes(id)), ...added]);
  }, [notes]);
  const chosen = drafts.filter((note) => selected.includes(note.id));
  const destinationName = currentThreadId && destination === currentThreadId ? (currentTitle ? `This thread: ${currentTitle}` : "This thread") : (choices.find((thread) => thread.id === destination)?.title ?? "Select a thread");
  const send = async () => {
    if (!destination || !chosen.length || busy || chosen.some((note) => note.anchorState !== "current")) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await rpc.call("notesSend", { environmentId, branch, threadId: destination, noteIds: chosen.map((note) => note.id) });
      setMessage(result.status === "sent" ? `Sent to ${destinationName}.` : result.status === "queued" ? `Queued to ${destinationName}.` : result.message);
      setSelected([]); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="gs-comment-list" aria-label="Local and thread comments">
    {drafts.length > 0 ? <div className="gs-send-toolbar">
      {currentThreadId ? <span className="text-xs text-muted-foreground">Send to {destinationName}</span> : <label className="gs-field"><span>Send to</span><select disabled={busy} value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">Choose a thread…</option>{choices.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}</select></label>}
      <span className="flex-1" />
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(chosen.length === drafts.length ? [] : drafts.map((note) => note.id))}>{chosen.length === drafts.length ? "Clear selection" : "Select all"}</Button>
      <Button size="sm" disabled={busy || !destination || !chosen.length || chosen.some((note) => note.anchorState !== "current")} onClick={() => void send()}>{busy ? "Sending…" : `Send to thread · ${chosen.length}`}</Button>
    </div> : null}
    {!currentThreadId && drafts.length > 0 && choices.length === 0 ? <p className="text-xs text-muted-foreground">No eligible threads found. Open this review beside a thread, or create one from Stack.</p> : null}
    {error ? <InlineError>{error}</InlineError> : null}{message ? <Notice>{message}</Notice> : null}
    {chosen.some((note) => note.anchorState !== "current") ? <Notice>Some selected comment lines changed or could not be checked. Deselect those comments before sending.</Notice> : null}
    <NoteList rpc={rpc} environmentId={environmentId} notes={visibleNotes} currentHeadSha={currentHeadSha} emptyText={emptyText} selectedIds={selected} onSelect={(id, checked) => setSelected((old) => checked ? [...old, id] : old.filter((item) => item !== id))} onChanged={onChanged} />
  </section>;
}
