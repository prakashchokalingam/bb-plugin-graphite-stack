// The stack rail: Graphite parents, forks, trunks, and per-layer status.
import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { LayerView, StackView } from "../contract";
import type { PrSummary } from "../lib/model";
import { cn } from "@/lib/utils";
import { Chip } from "./primitives";
import { prStateLabel, worktreeDirtyCount, worktreeFor } from "./model";
import type { RailRow } from "./model";

export function StackRail({
  view,
  rows,
  prs,
  selected,
  onSelect,
}: {
  view: StackView;
  rows: RailRow[];
  prs: Record<string, PrSummary>;
  selected: string | null;
  onSelect: (branch: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-layer]") ?? []);
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    buttons[next]?.focus();
  };
  return (
    <ul ref={listRef} className="gs-rail" aria-label="Graphite stack" onKeyDown={onKeyDown}>
      {rows.map(({ layer, depth }) => (
        <li key={layer.name} style={{ paddingLeft: `${Math.min(depth, 12) * 14}px` }}>
          <LayerRow
            layer={layer}
            view={view}
            pr={prs[layer.name] ?? null}
            selected={selected === layer.name}
            onSelect={() => onSelect(layer.name)}
          />
        </li>
      ))}
    </ul>
  );
}

function LayerRow({
  layer,
  view,
  pr,
  selected,
  onSelect,
}: {
  layer: LayerView;
  view: StackView;
  pr: PrSummary | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const current = view.currentBranch === layer.name;
  const worktree = worktreeFor(view, layer.name);
  const subtitle = layer.trunk ? "trunk" : (pr?.title ?? layer.commits[0]?.subject ?? (layer.detailsLoaded === false ? "Loading commits…" : "No commits"));
  const thread = layer.link?.thread ?? null;
  const prState = pr ? prStateLabel(pr) : null;
  const dirty = worktree ? worktreeDirtyCount(worktree) : 0;
  return (
    <button
      type="button"
      data-layer={layer.name}
      aria-pressed={selected}
      aria-current={current ? "true" : undefined}
      className={cn("gs-layer", layer.trunk && "gs-layer-trunk", selected && "gs-layer-selected")}
      onClick={onSelect}
    >
      <span className={cn("gs-node", current && "gs-node-current")} aria-hidden />
      <span className="min-w-0">
        <span className="gs-layer-name" title={layer.name}>
          {layer.name}
        </span>
        <span className="gs-layer-sub" title={subtitle}>
          {subtitle}
        </span>
        <span className="gs-layer-chips">
          {current ? <Chip tone="brand">Current</Chip> : null}
          {!layer.trunk && layer.detailsLoaded !== false ? <Chip>{layer.commitCount === 1 ? "1 commit" : `${layer.commitCount} commits`}</Chip> : null}
          {layer.needsRestack ? (
            <Chip tone="warning" icon="Repeat">
              Needs restack
            </Chip>
          ) : null}
          {layer.parent !== null && !view.layers.some((candidate) => candidate.name === layer.parent) ? (
            <Chip tone="warning" title={`Graphite parent: ${layer.parent}`}>Parent not tracked</Chip>
          ) : layer.parent !== null && !view.layers.some((candidate) => candidate.name === layer.parent && candidate.headSha !== null) ? (
            <Chip tone="warning" title={`Graphite parent: ${layer.parent}`}>Parent ref missing</Chip>
          ) : null}
          {layer.headSha === null ? <Chip tone="danger">Ref missing</Chip> : null}
          {prState ? <Chip tone={prState.tone}>{prState.label}</Chip> : null}
          {worktree?.operation ? (
            <Chip tone="danger" icon="AlertTriangle">
              {worktree.operation} stopped
            </Chip>
          ) : null}
          {worktree && dirty > 0 && !worktree.operation ? (
            <Chip tone="warning" title={`${dirty} uncommitted changes in ${worktree.path}`}>
              {dirty} uncommitted
            </Chip>
          ) : null}
          {thread ? (
            <Chip tone={thread.status === "idle" ? "muted" : "brand"} icon="MessageSquare" title={thread.title}>
              {thread.status === "idle" ? "Thread idle" : `Thread ${thread.status}`}
            </Chip>
          ) : !layer.trunk && layer.candidates.length > 0 ? (
            <Chip icon="MessageSquare">{layer.candidates.length === 1 ? "1 candidate" : `${layer.candidates.length} candidates`}</Chip>
          ) : null}
        </span>
      </span>
    </button>
  );
}
