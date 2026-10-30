// Explicit primary BB thread link for one Graphite branch.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { LayerView, LinkStatus, StackView, ThreadSummary } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Chip, InlineError, SectionLabel } from "./primitives";
import { errorMessage } from "./model";
import type { GraphiteRpc } from "./rpc";

const LINK_PROBLEM: Record<Exclude<LinkStatus, "valid">, string> = {
  "thread-missing": "The linked thread no longer exists. Link another thread.",
  "thread-archived": "The linked thread is archived.",
  "environment-mismatch": "The linked thread works in another environment than this branch.",
  "branch-missing": "The branch for this link no longer exists.",
};

export function ThreadLinks({
  rpc,
  view,
  layer,
  currentThreadId,
}: {
  rpc: GraphiteRpc;
  view: StackView;
  layer: LayerView;
  /** The thread that hosts this panel, or null on the project page. */
  currentThreadId: string | null;
}) {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = layer.link;
  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const linkThread = (threadId: string) =>
    run(`link:${threadId}`, () => rpc.call("linkThread", { environmentId: view.environmentId, branch: layer.name, threadId }));
  const unlink = () => run("unlink", () => rpc.call("unlinkThread", { environmentId: view.environmentId, branch: layer.name }));

  const candidates: ThreadSummary[] = layer.candidates.filter((thread) => thread.id !== link?.threadId && !thread.archived);
  const canLinkCurrent =
    currentThreadId !== null &&
    currentThreadId !== link?.threadId &&
    !candidates.some((thread) => thread.id === currentThreadId);

  const newThread = () => {
    navigate.toCompose({
      ...(view.projectId ? { projectId: view.projectId } : {}),
      ...(layer.environmentId ? { environmentId: layer.environmentId } : {}),
      initialPrompt: `Work on Graphite branch \`${layer.name}\`${layer.parent ? ` (parent \`${layer.parent}\`)` : ""}.`,
      focusPrompt: true,
    });
  };

  return (
    <section aria-label="Linked BB thread" className="gs-links">
      <SectionLabel>Linked BB thread</SectionLabel>
      {link ? (
        <div className="gs-link-row">
          <Icon name="MessageSquare" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">{link.thread?.title ?? link.threadId}</div>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {link.thread ? <Chip tone={link.thread.status === "idle" ? "muted" : "brand"}>{link.thread.status}</Chip> : null}
              {link.status !== "valid" ? <Chip tone="warning">{LINK_PROBLEM[link.status]}</Chip> : null}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={link.status === "thread-missing"}
            onClick={() => navigate.toThread(link.threadId)}
          >
            Open thread
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Unlink thread from ${layer.name}`}
            disabled={busy !== null}
            onClick={() => void unlink()}
          >
            <Icon name="X" className="size-4" aria-hidden />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No primary thread is linked to this branch.</p>
      )}
      {candidates.length > 0 ? (
        <div className="mt-2">
          <div className="pb-1 text-[11px] text-muted-foreground">Existing threads on this branch</div>
          <ul className="flex flex-col gap-1">
            {candidates.map((thread) => (
              <li key={thread.id} className="gs-link-row">
                <span className="min-w-0 flex-1 truncate text-xs" title={thread.title}>
                  {thread.title}
                </span>
                <Chip tone={thread.status === "idle" ? "muted" : "brand"}>{thread.status}</Chip>
                <Button size="sm" variant="ghost" onClick={() => navigate.toThread(thread.id)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void linkThread(thread.id)}
                >
                  {link ? "Make primary" : "Link"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {canLinkCurrent ? (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void linkThread(currentThreadId)}>
            <Icon name="Link" aria-hidden />
            Link this thread
          </Button>
        ) : null}
        {!layer.trunk ? (
          <Button size="sm" variant="ghost" onClick={newThread} aria-description="Opens the BB composer. You create the thread there.">
            <Icon name="Plus" aria-hidden />
            New thread…
          </Button>
        ) : null}
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
    </section>
  );
}
