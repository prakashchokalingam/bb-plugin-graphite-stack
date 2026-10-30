// Accessible line-anchor controls for the inline diff. Every anchor carries
// the diff's base and head SHAs.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DiffSnapshot } from "../lib/model";
import type { Note, PendingReview } from "../contract";
import { Button } from "@/components/ui/button";
import { InlineError, Notice, Segmented } from "./primitives";
import { draftKey, errorMessage, patchRanges, validateRange } from "./model";
import type { GraphiteRpc } from "./rpc";
import { useTextDraft } from "./rpc";

export type Destination = "private" | "pr";

interface DraftValue {
  side: "old" | "new";
  start: string;
  end: string;
  destination: Destination;
  body: string;
}

const EMPTY: DraftValue = { side: "new", start: "", end: "", destination: "private", body: "" };

function parseDraft(value: string | null): DraftValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DraftValue>;
    return {
      side: parsed.side === "old" ? "old" : "new",
      start: typeof parsed.start === "string" ? parsed.start : "",
      end: typeof parsed.end === "string" ? parsed.end : "",
      destination: parsed.destination === "pr" ? "pr" : "private",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return null;
  }
}

export function LineComposer({
  rpc,
  environmentId,
  repoKey,
  branch,
  path,
  snapshot,
  patch,
  noteThreadId,
  prAvailability,
  onSaved,
  initialAnchor,
  onClose,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  repoKey: string;
  branch: string;
  path: string;
  snapshot: DiffSnapshot;
  /** The loaded patch for `path`, or null while it loads or for binary files. */
  patch: string | null;
  /** BB thread that owns private notes, or null when no thread is linked. */
  noteThreadId: string | null;
  /** Null when PR comments are available, otherwise the reason. */
  prAvailability: string | null;
  onSaved: (destination: Destination, result: Note | PendingReview) => void;
  initialAnchor?: { side: "old" | "new"; line: number };
  onClose?: () => void;
}) {
  const key = draftKey(["line-comment", repoKey, branch, path, ...(initialAnchor ? [initialAnchor.side, String(initialAnchor.line)] : [])]);
  const stored = useTextDraft(rpc, key);
  const [open, setOpen] = useState(Boolean(initialAnchor));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const formId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const draft = useMemo(() => parseDraft(stored.value) ?? (initialAnchor ? { ...EMPTY, side: initialAnchor.side, start: String(initialAnchor.line) } : EMPTY), [stored.value, initialAnchor]);
  const hasSavedDraft = stored.loaded && stored.value !== "";
  useEffect(() => {
    if (hasSavedDraft) setOpen(true);
  }, [hasSavedDraft]);
  useEffect(() => {
    if (initialAnchor && open && stored.loaded) bodyRef.current?.focus();
  }, [initialAnchor, open, stored.loaded]);

  const update = (patchValue: Partial<DraftValue>) => {
    if (!stored.loaded) return;
    setTouched(true);
    const next = { ...draft, ...patchValue };
    const empty = next.body.trim() === "" && next.start === "" && next.end === "";
    stored.setValue(empty ? "" : JSON.stringify(next));
  };

  const ranges = useMemo(() => (patch === null ? null : patchRanges(patch)), [patch]);
  const start = Number(draft.start);
  const end = draft.end.trim() === "" ? start : Number(draft.end);
  // Never switch a destination by itself: a PR draft stays a PR draft.
  const destination: Destination = draft.destination;
  const destinationError =
    destination === "pr" && prAvailability !== null
      ? `PR comments are unavailable: ${prAvailability} Select Local draft to keep this text in BB.`
      : null;
  const rangeError =
    draft.start.trim() === "" ? "Enter a start line." : validateRange(ranges, draft.side, start, end, destination === "private");
  const canSubmit = !submitting && rangeError === null && destinationError === null && draft.body.trim() !== "";

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const anchor = {
      path,
      side: draft.side,
      startLine: start,
      endLine: end,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
    };
    try {
      const result = destination === "private"
        ? await rpc.call("noteCreate", { environmentId, branch, anchor, body: draft.body, threadId: noteThreadId })
        : await rpc.call("pendingAdd", { environmentId, branch, anchor, body: draft.body });
      // Drop queued draft saves first, so that none restores the text.
      // The comment already exists once the RPC succeeds. A draft cleanup
      // failure must not invite the user to submit the same comment again.
      await stored.clear().catch(() => undefined);
      setTouched(false);
      setOpen(false);
      onSaved(destination, result);
    } catch (cause) {
      // Keep the text. Do not retry by itself.
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  // Keep the legacy composer mounted so unfinished drafts can be restored.
  if (!open) return null;

  if (submitting) return <article className="gs-comment" aria-live="polite"><header className="gs-comment-head">{destination === "private" ? "Local draft" : "Pending PR comment"} · Saving…</header><p className="gs-comment-body">{draft.body}</p></article>;

  return (
    <form
      className="gs-composer"
      aria-labelledby={`${formId}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2">
        <h3 id={`${formId}-title`} className="text-xs font-semibold">
          New comment
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {draft.side === "old" ? "Parent" : "Branch"} · {draft.start ? `L${draft.start}${draft.end && draft.end !== draft.start ? `–${draft.end}` : ""}` : "Select lines"} · {destination === "private" ? "Local draft" : "Pending PR comment"}
        </span>
      </div>
      <details className="gs-composer-options" open={!initialAnchor || undefined}>
        <summary>Line range and destination</summary>
      <div className="gs-anchor-row">
        <Segmented
          label="Diff side"
          value={draft.side}
          options={[
            { value: "old", label: "Parent (old)" },
            { value: "new", label: "Branch (new)" },
          ]}
          onChange={(side) => update({ side })}
        />
        <label className="gs-field">
          <span>Start line</span>
          <input
            inputMode="numeric"
            value={draft.start}
            aria-invalid={touched && rangeError !== null}
            aria-describedby={`${formId}-range`}
            onChange={(event) => update({ start: event.target.value.replace(/[^0-9]/gu, "") })}
          />
        </label>
        <label className="gs-field">
          <span>End line</span>
          <input
            inputMode="numeric"
            placeholder={draft.start || "same"}
            value={draft.end}
            aria-describedby={`${formId}-range`}
            onChange={(event) => update({ end: event.target.value.replace(/[^0-9]/gu, "") })}
          />
        </label>
      </div>
      {touched && rangeError ? (
        <p id={`${formId}-range`} className="text-[11px] text-destructive">
          {rangeError}
        </p>
      ) : (
        <p id={`${formId}-range`} className="sr-only">
          Line numbers refer to the {draft.side === "old" ? "parent" : "branch"} side of this diff.
        </p>
      )}
      <fieldset className="gs-destination">
        <legend className="text-[11px] text-muted-foreground">Destination</legend>
        <label className="gs-radio">
          <input
            type="radio"
            name={`${formId}-dest`}
            checked={destination === "private"}
            onChange={() => update({ destination: "private" })}
          />
          <span>
            <strong>Local draft</strong>
            <small>{noteThreadId ? "Saved locally until you send it to the linked thread." : "Saved locally until you send it to a linked thread."}</small>
          </span>
        </label>
        <label className="gs-radio" aria-disabled={prAvailability !== null}>
          <input
            type="radio"
            name={`${formId}-dest`}
            disabled={prAvailability !== null && destination !== "pr"}
            checked={destination === "pr"}
            onChange={() => update({ destination: "pr" })}
          />
          <span>
            <strong>Pending PR comment</strong>
            <small>{prAvailability ?? "Added to your pending review. Nothing posts until you submit the review."}</small>
          </span>
        </label>
      </fieldset>
      </details>
      <label className="sr-only" htmlFor={`${formId}-body`}>
        Comment
      </label>
      <textarea
        id={`${formId}-body`}
        ref={bodyRef}
        className="gs-textarea"
        rows={3}
        readOnly={!stored.loaded}
        value={draft.body}
        placeholder={destination === "private" ? "Write a local draft" : "Review comment"}
        onChange={(event) => update({ body: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {destinationError ? <Notice>{destinationError}</Notice> : null}
      {error ? <InlineError>{error} Your text is kept.</InlineError> : null}
      {stored.status === "error" ? <Notice>Draft not saved: {stored.error}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground" aria-live="polite">
          {!stored.loaded ? "Loading draft…" : stored.status === "saving" ? "Saving draft…" : stored.status === "saved" ? "Draft saved" : ""}
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void stored.flush();
            setOpen(false);
            onClose?.();
          }}
        >
          Close
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {submitting ? "Saving…" : destination === "private" ? "Save draft" : "Add to pending review"}
        </Button>
      </div>
    </form>
  );
}
