// One lazily loaded file diff, drawn with BB's native diff renderer.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { InlineReviewDiff } from "./InlineReviewDiff";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import type { DiffViewMode } from "@get-bb/plugin-sdk/app";
import type { FileSidesResult, PatchResult } from "../lib/model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Chip, InlineError, Notice, Spinner } from "./primitives";
import type { FileKind } from "./model";
import { useResource } from "./rpc";

export interface FileDiffProps {
  /** Changes when the file revision changes. */
  resourceKey: string;
  /** Increase to read the patch again with the same key. */
  version?: number;
  path: string;
  oldPath: string | null;
  kind: FileKind;
  additions: number | null;
  deletions: number | null;
  view: DiffViewMode;
  loadPatch: () => Promise<PatchResult>;
  /** Omit when full-file context is not available (uncommitted files). */
  loadSides?: () => Promise<FileSidesResult>;
  viewed?: { value: boolean; onChange: (value: boolean) => void; busy: boolean };
  /** Reports the loaded patch so anchor controls can validate ranges. */
  onPatch?: (patch: string | null) => void;
  inlineReview?: { renderLine: (side: "old" | "new", line: number) => ReactNode; onAdd: (side: "old" | "new", line: number) => void };
}

const KIND_LABEL: Record<FileKind, string | null> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  mode: "Type changed",
  binary: "Binary",
  conflict: "Conflict",
  modified: null,
};

export function FileDiff(props: FileDiffProps) {
  const { resourceKey, path, oldPath, kind, view, loadPatch, loadSides, viewed, onPatch } = props;
  const [fullContext, setFullContext] = useState(false);
  const [inlineMode, setInlineMode] = useState(true);
  const [showLarge, setShowLarge] = useState(false);
  const patch = useResource(`${resourceKey}#patch`, loadPatch, { version: props.version ?? 0 });
  const loadedPatch = patch.data === undefined || patch.data.binary ? null : patch.data.patch;
  useEffect(() => {
    onPatch?.(loadedPatch);
  }, [loadedPatch, onPatch]);
  const sides = useResource(fullContext && loadSides ? `${resourceKey}#sides` : null, () => loadSides!());
  const label = KIND_LABEL[kind];
  const largePatch = patch.data !== undefined && patch.data.bytes > 400_000;

  let body;
  if (patch.loading && patch.data === undefined) {
    body = (
      <div className="p-3">
        <Spinner label="Loading diff…" />
      </div>
    );
  } else if (patch.error !== null && patch.data === undefined) {
    body = (
      <div className="p-3">
        <InlineError onRetry={patch.reload}>{patch.error}</InlineError>
      </div>
    );
  } else if (patch.data === undefined) {
    body = null;
  } else if (patch.data.binary || kind === "binary") {
    body = <p className="gs-diff-note">Binary file. BB shows no line diff for binary content.</p>;
  } else if (patch.data.patch.trim() === "") {
    body = (
      <p className="gs-diff-note">
        {kind === "renamed" ? "Renamed without content changes." : kind === "mode" ? "Only the file mode changed." : "No line changes."}
      </p>
    );
  } else if (largePatch && !showLarge) {
    body = (
      <div className="gs-diff-note flex flex-wrap items-center gap-2">
        <span>
          Large diff ({Math.round(patch.data.bytes / 1024)} KB). Rendering it can slow this panel.
        </span>
        <Button size="sm" variant="outline" onClick={() => setShowLarge(true)}>
          Show diff
        </Button>
      </div>
    );
  } else {
    const contents =
      fullContext && sides.data?.status === "ok"
        ? {
            old: sides.data.old ?? { path: oldPath ?? path, content: "" },
            new: sides.data.new ?? { path, content: "" },
          }
        : undefined;
    body = (
      <>
        {patch.data.truncated ? (
          <Notice>The diff is larger than the read limit. BB shows only the first part.</Notice>
        ) : null}
        {props.inlineReview && inlineMode && !fullContext ? <InlineReviewDiff patch={patch.data.patch} path={path} renderLine={props.inlineReview.renderLine} onAdd={props.inlineReview.onAdd} /> : <Diff
          patch={patch.data.patch}
          path={path}
          view={view}
          {...(contents ? { experimental_fullFileContents: contents } : {})}
        />}
      </>
    );
  }

  return (
    <article className="gs-file" aria-label={`Diff of ${path}`}>
      <header className="gs-file-head">
        <Icon name="FileText" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
          {oldPath && oldPath !== path ? (
            <>
              <span className="text-muted-foreground">{oldPath} → </span>
              {path}
            </>
          ) : (
            path
          )}
        </span>
        {label ? <Chip tone={kind === "deleted" || kind === "conflict" ? "danger" : "muted"}>{label}</Chip> : null}
        {props.additions !== null || props.deletions !== null ? (
          <span className="gs-stats" aria-label={`${props.additions ?? 0} additions, ${props.deletions ?? 0} deletions`}>
            <span className="gs-add">+{props.additions ?? 0}</span> <span className="gs-del">−{props.deletions ?? 0}</span>
          </span>
        ) : null}
        {props.inlineReview ? <Button size="sm" variant="ghost" onClick={() => { setFullContext(false); setInlineMode((value) => !value); }}>{inlineMode ? "Native diff" : "Inline comments"}</Button> : null}
        {loadSides && kind !== "binary" ? (
          <label className="gs-check">
            <input type="checkbox" checked={fullContext} onChange={(event) => setFullContext(event.target.checked)} />
            Full file
          </label>
        ) : null}
        {viewed ? (
          <label className="gs-check">
            <input
              type="checkbox"
              checked={viewed.value}
              disabled={viewed.busy}
              onChange={(event) => viewed.onChange(event.target.checked)}
            />
            Viewed
          </label>
        ) : null}
      </header>
      {fullContext && sides.loading ? (
        <div className="px-3 pt-2">
          <Spinner label="Loading full file…" />
        </div>
      ) : null}
      {fullContext && sides.data && sides.data.status !== "ok" ? (
        <div className="px-3 pt-2">
          <Notice>
            {sides.data.message ??
              (sides.data.status === "too-large"
                ? "The file is too large for full-file context."
                : sides.data.status === "binary"
                  ? "Binary files have no full-file context."
                  : "Full-file context is unavailable.")}
          </Notice>
        </div>
      ) : null}
      {fullContext && sides.error ? (
        <div className="px-3 pt-2">
          <InlineError onRetry={sides.reload}>{sides.error}</InlineError>
        </div>
      ) : null}
      <div className="gs-file-body">{body}</div>
    </article>
  );
}
