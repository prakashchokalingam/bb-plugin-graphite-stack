// Pull request review threads and the pending review. Every GitHub write is
// explicit. An unknown outcome blocks a retry until the user checks GitHub.
import { useEffect, useRef, useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { PendingReview } from "../contract";
import type { PrSourceStatus, PrSummary, PrThread, ReviewEvent } from "../lib/model";
import { Button } from "@/components/ui/button";
import { Chip, InlineError, Notice, Spinner } from "./primitives";
import { anchorLabel, draftKey, errorMessage, fileName, prLink } from "./model";
import type { GraphiteRpc } from "./rpc";
import { useDebouncedSave, useTextDraft } from "./rpc";

/** Null when PR writes are available; otherwise the reason they are off. */
export function prUnavailableReason(status: PrSourceStatus | undefined, message: string | null, pr: PrSummary | null): string | null {
  switch (status) {
    case undefined:
      return "Pull request state is loading.";
    case "no-remote":
      return "This repository has no remote, so this branch has no pull request.";
    case "not-github":
      return "The remote is not on GitHub.";
    case "gh-missing":
      return "The GitHub CLI (gh) is not installed on the environment host.";
    case "gh-unauthenticated":
      return "The GitHub CLI is not signed in on the environment host. Run gh auth login there.";
    case "error":
      return message ?? "GitHub returned an error.";
    default:
      break;
  }
  if (pr === null) return "This branch has no pull request. Submit it with Graphite first.";
  if (pr.state !== "OPEN") return `The pull request is ${pr.state.toLowerCase()}.`;
  return null;
}

type WriteOutcome = { outcome: "ok" | "rejected" | "unknown"; message: string | null };

function outcomeText(result: WriteOutcome): string | null {
  if (result.outcome === "ok") return null;
  if (result.outcome === "rejected") return result.message ?? "GitHub rejected the request.";
  return "GitHub did not confirm this write. Refresh the threads to check before you try again.";
}

export function PrThreads({
  rpc,
  environmentId,
  branch,
  threads,
  truncated,
  onChanged,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  branch: string;
  threads: PrThread[];
  truncated: boolean;
  onChanged: () => void;
}) {
  if (threads.length === 0) return <p className="text-xs text-muted-foreground">No pull request comment threads.</p>;
  return (
    <>
      {truncated ? <Notice>GitHub returned only the first threads. Open the pull request to see all threads.</Notice> : null}
      <ul className="flex flex-col gap-2">
        {threads.map((thread) => (
          <li key={thread.id}>
            <PrThreadCard rpc={rpc} environmentId={environmentId} branch={branch} thread={thread} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </>
  );
}

function PrThreadCard({
  rpc,
  environmentId,
  branch,
  thread,
  onChanged,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  branch: string;
  thread: PrThread;
  onChanged: () => void;
}) {
  const replyDraft = useTextDraft(rpc, draftKey(["pr-reply", environmentId, branch, thread.id]));
  const reply = replyDraft.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set after an unknown outcome. Cleared only when fresh thread data arrives.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const threadVersion = `${thread.isResolved}:${thread.comments.length}`;
  const seenVersion = useRef(threadVersion);
  useEffect(() => {
    if (seenVersion.current !== threadVersion) {
      seenVersion.current = threadVersion;
      setUnconfirmed(false);
    }
  }, [threadVersion]);

  const write = async (action: () => Promise<WriteOutcome>, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      const text = outcomeText(result);
      if (result.outcome === "unknown") setUnconfirmed(true);
      if (text) setError(text);
      else {
        onOk?.();
        onChanged();
      }
    } catch (cause) {
      // A transport failure is also an unknown outcome for a write.
      setUnconfirmed(true);
      setError(`${errorMessage(cause)} The write state is unknown. Refresh before you try again.`);
    } finally {
      setBusy(false);
    }
  };

  const sendReply = () =>
    write(
      () => rpc.call("prReply", { environmentId, branch, threadId: thread.id, body: reply.trim() }),
      () => void replyDraft.clear(),
    );

  const line = thread.line ?? thread.originalLine;
  return (
    <article className={thread.isResolved ? "gs-comment gs-comment-resolved" : "gs-comment"} aria-label={`Pull request thread on ${thread.path}`}>
      <header className="gs-comment-head">
        <Chip icon="GitPullRequest">Remote PR</Chip>
        <span className="min-w-0 truncate font-mono text-[11px]" title={thread.path}>
          {fileName(thread.path)}
          {line !== null ? ` · ${thread.diffSide === "LEFT" ? "parent" : "branch"} L${thread.startLine && thread.startLine !== line ? `${thread.startLine}–${line}` : line}` : ""}
        </span>
        {thread.isOutdated ? <Chip tone="warning">Outdated</Chip> : null}
        {thread.isResolved ? <Chip tone="success">Resolved on GitHub</Chip> : null}
      </header>
      {thread.commentsTruncated ? <p className="text-[11px] text-muted-foreground">Older comments are not shown.</p> : null}
      <ul className="gs-replies gs-replies-flat">
        {thread.comments.map((comment) => (
          <li key={comment.id}>
            <div className="text-[11px] font-medium">
              {comment.author}
              {comment.state === "PENDING" ? <span className="ml-1 text-muted-foreground">(pending)</span> : null}
            </div>
            <p className="gs-comment-body">{comment.body}</p>
          </li>
        ))}
      </ul>
      {thread.viewerCanReply ? (
        <div className="gs-reply">
          <label className="sr-only" htmlFor={`pr-reply-${thread.id}`}>
            Reply on the pull request
          </label>
          <textarea
            id={`pr-reply-${thread.id}`}
            className="gs-textarea"
            rows={1}
            placeholder="Reply on the pull request (posts publicly)"
            value={reply}
            readOnly={!replyDraft.loaded}
            onChange={(event) => replyDraft.setValue(event.target.value)}
          />
        </div>
      ) : null}
      {error ? <InlineError onRetry={unconfirmed ? onChanged : undefined}>{error}</InlineError> : null}
      <div className="flex flex-wrap gap-1.5">
        {thread.viewerCanReply ? (
          <Button size="sm" variant="outline" disabled={busy || unconfirmed || reply.trim() === ""} onClick={() => void sendReply()}>
            Post reply to GitHub
          </Button>
        ) : null}
        {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || unconfirmed}
            onClick={() =>
              void write(() => rpc.call("prSetResolved", { environmentId, branch, threadId: thread.id, resolved: !thread.isResolved }))
            }
          >
            {thread.isResolved ? "Reopen on GitHub" : "Resolve on GitHub"}
          </Button>
        ) : null}
        {busy ? <Spinner label="Waiting for GitHub…" /> : null}
      </div>
    </article>
  );
}

const EVENTS: Array<{ value: ReviewEvent; label: string; hint: string }> = [
  { value: "COMMENT", label: "Comment", hint: "Post comments without a decision." },
  { value: "APPROVE", label: "Approve", hint: "Approve the pull request." },
  { value: "REQUEST_CHANGES", label: "Request changes", hint: "Block the merge until the author addresses the comments." },
];

export function FinishReview({
  rpc,
  environmentId,
  branch,
  pr,
  pending,
  unavailable,
  onChanged,
  onPending,
}: {
  rpc: GraphiteRpc;
  environmentId: string;
  branch: string;
  pr: PrSummary | null;
  pending: PendingReview | null;
  unavailable: string | null;
  onChanged: () => void;
  onPending: (pending: PendingReview | null) => void;
}) {
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState(pending?.body ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const bodyDirty = useRef(false);
  const saver = useDebouncedSave(async (value) => {
    const next = await rpc.call("pendingSetBody", { environmentId, branch, body: value });
    bodyDirty.current = false;
    return next;
  });
  useEffect(() => {
    if (!bodyDirty.current) setBody(pending?.body ?? "");
  }, [pending?.body]);

  const comments = pending?.comments ?? [];
  const submission = pending?.submission ?? null;
  const outdated = comments.filter((comment) => comment.anchorState === "outdated").length;
  const canSubmit =
    unavailable === null &&
    submission === null &&
    busy === null &&
    (comments.length > 0 || body.trim() !== "" || event === "APPROVE");

  const submit = async () => {
    setBusy("submit");
    setResult(null);
    try {
      await saver.flush();
      const response = await rpc.call("submitReview", { environmentId, branch, event });
      onPending(response.pending);
      switch (response.outcome) {
        case "ok":
          setResult({ tone: "success", text: "Review posted." });
          break;
        case "rejected":
          setResult({ tone: "danger", text: response.message ?? "GitHub rejected the review. Your comments are kept." });
          break;
        case "blocked":
          setResult({ tone: "warning", text: response.message ?? "The review cannot be submitted now. Your comments are kept." });
          break;
        case "unknown":
          setResult({
            tone: "warning",
            text: response.message ?? "GitHub did not confirm the review. Check GitHub before you submit again.",
          });
          break;
      }
      onChanged();
    } catch (cause) {
      setResult({
        tone: "warning",
        text: `${errorMessage(cause)} The review state is unknown. Check GitHub before you submit again.`,
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    setBusy("reconcile");
    try {
      const response = await rpc.call("reconcileReview", { environmentId, branch });
      onPending(response.pending);
      const text =
        response.outcome === "posted"
          ? "GitHub has the review. BB cleared the pending comments."
          : response.outcome === "not-posted"
            ? "GitHub does not have the review. Your comments are kept, and you can submit again."
            : response.outcome === "nothing"
              ? "No submission is waiting for a check."
              : (response.message ?? "BB could not check GitHub. Try again later.");
      setResult({ tone: response.outcome === "error" ? "danger" : response.outcome === "posted" ? "success" : "warning", text });
      onChanged();
    } catch (cause) {
      setResult({ tone: "danger", text: errorMessage(cause) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (commentId: string) => {
    setBusy(`remove:${commentId}`);
    const previous = pending;
    if (previous) onPending({ ...previous, comments: previous.comments.filter((comment) => comment.id !== commentId) });
    try {
      onPending(await rpc.call("pendingRemove", { environmentId, branch, commentId }));
      onChanged();
    } catch (cause) {
      onPending(previous);
      setResult({ tone: "danger", text: errorMessage(cause) });
    } finally {
      setBusy(null);
    }
  };

  const link = pr ? prLink(pr) : null;
  const hasStoredReview =
    comments.length > 0 || (pending?.body ?? "").trim() !== "" || submission !== null || (pending?.lastError ?? null) !== null;
  // No PR and nothing stored: the section above already explains why. Keep
  // the private-note workflow primary and show no disabled review form.
  if (unavailable !== null && !hasStoredReview) return null;
  return (
    <section className="gs-review" aria-label="Finish review">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">Pending review</h3>
        <Chip>{comments.length === 1 ? "1 comment" : `${comments.length} comments`}</Chip>
        {outdated > 0 ? <Chip tone="warning">{outdated} outdated</Chip> : null}
        {link ? (
          <UrlLink href={link.url} className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline">
            {link.label}
          </UrlLink>
        ) : null}
      </div>
      {unavailable ? (
        <Notice icon="Lock">
          {unavailable} BB keeps these pending comments. Submit them when the pull request is available.
        </Notice>
      ) : null}
      {submission ? (
        <Notice tone="warning" icon="AlertTriangle">
          {submission.state === "in-flight"
            ? "A submission is in progress."
            : "The last submission has an unknown outcome. Check GitHub before you submit again."}
          <div className="mt-1.5">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void reconcile()}>
              {busy === "reconcile" ? "Checking…" : "Check GitHub"}
            </Button>
          </div>
        </Notice>
      ) : null}
      {pending?.lastError ? <InlineError>{pending.lastError}</InlineError> : null}
      {comments.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {comments.map((comment) => (
            <li key={comment.id} className="gs-pending">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{anchorLabel(comment)}</span>
                {comment.anchorState === "outdated" ? <Chip tone="warning">Outdated</Chip> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null || submission !== null}
                  aria-label={`Remove pending comment on ${anchorLabel(comment)}`}
                  onClick={() => void remove(comment.id)}
                >
                  Remove
                </Button>
              </div>
              <p className="gs-comment-body">{comment.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No pending PR comments. Add one from a file with the Pending PR comment destination.</p>
      )}
      <label className="text-[11px] text-muted-foreground" htmlFor="gs-review-body">
        Summary
      </label>
      <textarea
        id="gs-review-body"
        className="gs-textarea"
        rows={3}
        value={body}
        disabled={unavailable !== null || submission !== null}
        onChange={(changeEvent) => {
          bodyDirty.current = true;
          setBody(changeEvent.target.value);
          saver.schedule(changeEvent.target.value);
        }}
      />
      {saver.status === "error" ? <Notice>Summary not saved: {saver.error}</Notice> : null}
      <fieldset className="gs-destination" disabled={unavailable !== null || submission !== null}>
        <legend className="text-[11px] text-muted-foreground">Review outcome</legend>
        {EVENTS.map((option) => (
          <label key={option.value} className="gs-radio">
            <input type="radio" name="gs-review-event" checked={event === option.value} onChange={() => setEvent(option.value)} />
            <span>
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {result ? (
        result.tone === "danger" ? (
          <InlineError>{result.text}</InlineError>
        ) : (
          <Notice tone={result.tone} icon={result.tone === "success" ? "Check" : "AlertTriangle"}>
            {result.text}
          </Notice>
        )
      ) : null}
      <div className="flex justify-end">
        <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {busy === "submit" ? "Submitting…" : "Submit review"}
        </Button>
      </div>
    </section>
  );
}
