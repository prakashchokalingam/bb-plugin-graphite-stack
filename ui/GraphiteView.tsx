// The Graphite review workspace for one BB environment: stack rail, layer
// header, changed files, inline diff, comments, and stack actions.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { LayerView, OperationRequest, OperationResult, StackView } from "../contract";
import type { ChangedFile, UncommittedFile } from "../lib/model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { FileDiff } from "./FileDiff";
import { LineComposer } from "./LineComposer";
import { NoteList } from "./Notes";
import { ThreadReview } from "./ThreadReview";
import { LastOperation, OperationDialog } from "./Operations";
import { FinishReview, PrThreads, prUnavailableReason } from "./PrReview";
import { StackRail } from "./StackRail";
import { ThreadLinks } from "./ThreadLinks";
import { Chip, InlineError, Notice, SectionLabel, Segmented, Spinner, StatePanel } from "./primitives";
import {
  checksLabel,
  defaultSelection,
  fileDir,
  fileKey,
  fileKind,
  fileName,
  prLink,
  prStateLabel,
  railRows,
  relativeTime,
  shortSha,
  stackMembers,
  stackRows,
  statusCopy,
  untrackedBranches,
  worktreeFor,
} from "./model";
import { useGraphiteRpc, useGraphiteVersion, useResource } from "./rpc";
import type { GraphiteRpc } from "./rpc";

type Tab = "changes" | "comments" | "commits";
type Scope = "stack" | "all";
const SCOPE_KEY = "bb-graphite-stack:scope";

function readScope(repoKey: string): { scope?: string; anchor?: string | null } | null {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(`${SCOPE_KEY}:${repoKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeScope(repoKey: string, value: { scope: Scope; anchor: string | null }) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(`${SCOPE_KEY}:${repoKey}`, JSON.stringify(value));
  } catch {
    // Private mode: the scope still works for this session.
  }
}

/** Read the topology first, then fetch only the visible branches in batches. */
function useStackDetails(rpc: GraphiteRpc, environmentId: string, base: StackView | undefined, scope: Scope, anchor: string | null, enabled: boolean) {
  const [state, setState] = useState<{ base: StackView | undefined; view: StackView | undefined; error: string | null }>({ base: undefined, view: undefined, error: null });
  const [retry, setRetry] = useState(0);
  const current = state.base === base ? state.view : base;
  const names = base?.status === "ready"
    ? (scope === "all" ? base.layers : anchor ? stackMembers(base, anchor) : []).map((layer) => layer.name)
    : [];
  const key = JSON.stringify(names);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  useEffect(() => {
    if (!base || base.status !== "ready" || !enabled) return;
    let cancelled = false;
    let working = state.base === base && state.view ? state.view : base;
    setState({ base, view: working, error: null });
    const wanted: string[] = JSON.parse(key);
    const missing = wanted.filter((name) => working.layers.find((layer) => layer.name === name)?.detailsLoaded === false);
    (async () => {
      try {
        for (let i = 0; i < missing.length; i += 60) {
          const batch = missing.slice(i, i + 60);
          const result = await rpcRef.current.call("stack", { environmentId, detailBranches: batch });
          if (cancelled) return;
          if (result.status !== "ready" || result.repoKey !== base.repoKey) throw new Error("Stack details could not be loaded. Refresh the stack.");
          const requested = new Set(batch);
          const detail = new Map(result.layers.map((layer) => [layer.name, layer]));
          const statuses = new Map(result.worktrees.map((worktree) => [worktree.path, worktree]));
          // Reject a mixed snapshot if a ref or parent changed during the read.
          for (const layer of working.layers) {
            const next = detail.get(layer.name);
            if (requested.has(layer.name)) {
              const parent = layer.parent ? working.layers.find((item) => item.name === layer.parent) : null;
              const nextParent = layer.parent ? detail.get(layer.parent) : null;
              if (!next || next.headSha !== layer.headSha || next.parent !== layer.parent || (parent && nextParent?.headSha !== parent.headSha)) {
                throw new Error("The stack changed during the read. Refresh the stack.");
              }
            }
          }
          working = {
            ...working,
            layers: working.layers.map((layer) => requested.has(layer.name) ? (detail.get(layer.name) ?? layer) : layer),
            worktrees: working.worktrees.map((worktree) => {
              const next = statuses.get(worktree.path);
              return next && worktree.branch && requested.has(worktree.branch) && next.branch === worktree.branch && next.headSha === worktree.headSha ? next : worktree;
            }),
          };
          setState({ base, view: working, error: null });
        }
      } catch (error) {
        if (!cancelled) setState({ base, view: working, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [base, key, enabled, environmentId, retry]);
  const loaded = names.filter((name) => current?.layers.find((layer) => layer.name === name)?.detailsLoaded !== false).length;
  return { view: current, loaded, total: names.length, error: state.base === base ? state.error : null, retry: () => setRetry((value) => value + 1) };
}

const UNCOMMITTED_POLL_MS = 10_000;
type FileSelection = { source: "layer" | "uncommitted"; path: string } | null;

export function GraphiteView({
  environmentId,
  currentThreadId,
  visible,
  toolbar,
}: {
  environmentId: string;
  currentThreadId: string | null;
  /** False while the hosting tab is hidden. Reads pause, then catch up. */
  visible: boolean;
  /** Extra controls for the app bar, such as a repository picker. */
  toolbar?: ReactNode;
}) {
  const rpc = useGraphiteRpc();
  const [repoKey, setRepoKey] = useState<string | null>(null);
  const realtimeVersion = useGraphiteVersion(repoKey);
  // Explicit Refresh: both counters only grow, so their sum only grows.
  const [manual, setManual] = useState(0);
  const version = realtimeVersion + manual;
  // The next prs read asks the server to read GitHub again, not its cache.
  const forceRemote = useRef(false);
  const refreshAll = () => {
    forceRemote.current = true;
    setManual((value) => value + 1);
  };
  const stack = useResource(`stack:${environmentId}`, () => rpc.call("stack", { environmentId, detailBranches: [] }), { enabled: visible, version });
  const [selected, setSelected] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [scope, setScope] = useState<Scope>("stack");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const base = stack.data;
  const initialAnchor = anchor ?? selected ?? (base?.currentBranch && base.layers.some((item) => item.name === base.currentBranch && !item.trunk) ? base.currentBranch : null);
  const details = useStackDetails(rpc, environmentId, base, scope, initialAnchor, visible && restoredFor === base?.repoKey);
  const view = details.view;
  useEffect(() => {
    if (view?.repoKey) setRepoKey(view.repoKey);
  }, [view?.repoKey]);
  const ready = view?.status === "ready";
  const prs = useResource(
    ready ? `prs:${environmentId}` : null,
    () => {
      const refresh = forceRemote.current;
      forceRemote.current = false;
      return rpc.call("prs", { environmentId, refresh });
    },
    { enabled: visible, version },
  );
  const lastOperation = useResource(ready ? `lastop:${environmentId}` : null, () => rpc.call("lastOperation", { environmentId }), {
    enabled: visible,
    version,
  });
  // Restore the scope and anchor for this repository once.
  useEffect(() => {
    const repoKey = view?.repoKey ?? null;
    if (!repoKey || restoredFor === repoKey) return;
    const saved = readScope(repoKey);
    const names = new Set((view?.layers ?? []).map((layer) => layer.name));
    if (saved && typeof saved === "object") {
      if (saved.anchor && names.has(saved.anchor)) setAnchor(saved.anchor);
      if (saved.scope === "all" || saved.scope === "stack") setScope(saved.scope);
    }
    setRestoredFor(repoKey);
  }, [view?.repoKey, restoredFor]);

  // Persist only after the restore, so defaults do not overwrite a saved stack.
  useEffect(() => {
    const repoKey = view?.repoKey ?? null;
    if (!repoKey || restoredFor !== repoKey) return;
    writeScope(repoKey, { scope, anchor });
  }, [view?.repoKey, restoredFor, scope, anchor]);

  // A trunk has no single stack, so this view falls back to All.
  useEffect(() => {
    if (!view || view.status !== "ready" || restoredFor !== view.repoKey) return;
    const byName = new Map(view.layers.map((layer) => [layer.name, layer]));
    const current = view.currentBranch ? (byName.get(view.currentBranch) ?? null) : null;
    const candidate = anchor ?? selected ?? (current && !current.trunk ? current.name : null);
    if (scope === "stack" && !candidate) setScope("all");
  }, [view, restoredFor, scope, anchor, selected]);

  // Keep the selection inside the scoped stack.
  useEffect(() => {
    if (!view || view.status !== "ready") return;
    const byName = new Map(view.layers.map((layer) => [layer.name, layer]));
    if (selected === null || !byName.has(selected)) {
      setSelected(defaultSelection(view));
      return;
    }
    if (scope !== "stack") return;
    const name = anchor ?? selected;
    const target = name ? (byName.get(name) ?? null) : null;
    if (!target || target.trunk) return;
    if (!stackMembers(view, target.name).some((layer) => layer.name === selected)) setSelected(target.name);
  }, [view, selected, scope, anchor]);

  if (!view) {
    if (stack.error) {
      return (
        <Frame toolbar={toolbar}>
          <StatePanel icon="AlertTriangle" title="Cannot load the stack" actions={<Button size="sm" variant="outline" onClick={stack.reload}>Retry</Button>}>
            {stack.error}
          </StatePanel>
        </Frame>
      );
    }
    return (
      <Frame toolbar={toolbar}>
        <div className="p-6">
          <Spinner label="Reading the Graphite stack…" />
        </div>
      </Frame>
    );
  }

  if (view.status !== "ready") {
    const copy = statusCopy(view.status);
    return (
      <Frame view={view} toolbar={toolbar}>
        <StatePanel
          icon={view.status === "no-gt" || view.status === "gt-unsupported" ? "Terminal" : "GitBranch"}
          title={copy.title}
          actions={
            <>
              {view.status === "gt-uninitialized" ? (
                <Button size="sm" onClick={() => setOperation({ kind: "init", trunk: view.localBranches.includes("main") ? "main" : "" })}>
                  Initialize Graphite…
                </Button>
              ) : null}
              {view.status === "no-gt" ? (
                <Button size="sm" variant="outline" asChild>
                  <UrlLink href="https://graphite.com/docs/install-the-cli">Install instructions</UrlLink>
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={stack.reload}>
                Retry
              </Button>
            </>
          }
        >
          <p>{copy.body}</p>
          {view.message ? <p className="mt-1 font-mono text-[11px]">{view.message}</p> : null}
          {view.status === "gt-unsupported" && view.gtVersion ? <p className="mt-1">Installed gt {view.gtVersion}.</p> : null}
        </StatePanel>
        <OperationDialog
          rpc={rpc}
          view={view}
          initial={operation}
          onClose={() => setOperation(null)}
          onFinished={() => stack.reload()}
        />
      </Frame>
    );
  }

  const byName = new Map(view.layers.map((item) => [item.name, item]));
  const current = view.currentBranch ? (byName.get(view.currentBranch) ?? null) : null;
  const anchorName = (() => {
    const name = anchor ?? selected ?? (current && !current.trunk ? current.name : null);
    const layer = name ? (byName.get(name) ?? null) : null;
    return layer && !layer.trunk ? layer.name : null;
  })();
  const scoped = anchorName ? stackRows(view, anchorName) : [];
  const activeScope: Scope = scope === "stack" && anchorName ? "stack" : "all";
  const rows = activeScope === "stack" ? scoped : railRows(view);
  const railNames = new Set(rows.map((row) => row.layer.name));
  const needsRestack = rows.filter((row) => row.layer.needsRestack).length;
  const layer = view.layers.find((item) => item.name === selected) ?? null;
  const prMap = prs.data?.prs ?? {};
  const untracked = untrackedBranches(view);
  const incompleteLayers = view.layers.filter((item) => railNames.has(item.name) && item.parent !== null &&
    !view.layers.some((parent) => parent.name === item.parent && parent.headSha !== null));
  const stoppedWorktrees = view.worktrees.filter((worktree) => worktree.operation !== null);
  const changeScope = (next: Scope) => {
    if (next === "stack") {
      if (!anchorName) return;
      setAnchor(anchorName);
    }
    setScope(next);
  };
  const selectLayer = (name: string) => {
    setSelected(name);
    const target = byName.get(name) ?? null;
    if (activeScope === "all" && target && !target.trunk) {
      setAnchor(name);
      setScope("stack");
    }
  };
  const onFinished = (_result: OperationResult) => {
    stack.reload();
    lastOperation.reload();
  };

  return (
    <Frame
      view={view}
      toolbar={
        <>
          {toolbar}
          {stack.loading ? <Spinner label="Refreshing" /> : null}
          {view.busyRepo ? <Chip tone="warning">Operation running</Chip> : null}
          <Button size="sm" variant="ghost" disabled={view.busyRepo} onClick={() => setOperation({ kind: "create", name: "", message: "", stageAll: false })}>
            <Icon name="GitBranch" aria-hidden />
            Create…
          </Button>
          <Button size="sm" variant="ghost" disabled={view.busyRepo} onClick={() => setOperation({ kind: "sync" })}>
            <Icon name="ArrowReloadHorizontal" aria-hidden />
            Sync…
          </Button>
          <Button size="sm" variant="ghost" aria-label="Refresh all data" onClick={refreshAll}>
            <Icon name="RotateCcw" aria-hidden />
          </Button>
        </>
      }
    >
      <div className="gs-layout">
        <aside className="gs-sidebar" aria-label="Stack">
          <SectionLabel trailing={<span className="text-[10px] normal-case">{view.gtVersion ? `gt ${view.gtVersion}` : null}</span>}>
            Stack
          </SectionLabel>
          {!view.gtTested ? <Notice>This gt version is outside the tested range. Check previews with care.</Notice> : null}
          <div className="gs-scope">
            <Segmented
              label="Stack scope"
              value={activeScope}
              onChange={changeScope}
              options={[
                { value: "stack", label: scoped.length > 0 ? `This stack · ${scoped.length}` : "This stack", disabled: !anchorName },
                { value: "all", label: `All · ${view.layers.length}` },
              ]}
            />
          </div>
          {activeScope === "stack" ? (
            <p className="gs-rail-note">
              {rows.filter((row) => !row.layer.trunk).length} branches{needsRestack > 0 ? ` · ${needsRestack} ${needsRestack === 1 ? "needs" : "need"} restack` : ""}
            </p>
          ) : null}
          {details.error ? <InlineError onRetry={details.retry}>{details.error}</InlineError> : null}
          {details.loaded < details.total && !details.error ? <p className="gs-rail-note">Loading details · {details.loaded}/{details.total}</p> : null}
          <StackRail view={view} rows={rows} prs={prMap} selected={selected} onSelect={selectLayer} />
          {untracked.length > 0 ? (
            <details className="gs-untracked" open={!view.currentTracked}>
              <summary>Untracked branches ({untracked.length})</summary>
              <ul>
                {untracked.map((branch) => (
                  <li key={branch}>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={branch}>
                      {branch}
                      {branch === view.currentBranch ? " (current)" : ""}
                    </span>
                    <Button size="sm" variant="ghost" disabled={view.busyRepo} onClick={() => setOperation({ kind: "track", branch, parent: "" })}>
                      Track…
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {prs.data && prs.data.status !== "ok" ? (
            <p className="gs-side-note">{prUnavailableReason(prs.data.status, prs.data.message, null)}</p>
          ) : prs.data?.stale ? (
            <p className="gs-side-note">
              PR state from {prs.data.fetchedAt ? relativeTime(prs.data.fetchedAt) : "cache"}.{" "}
              <button type="button" className="underline" onClick={refreshAll}>
                Refresh
              </button>
            </p>
          ) : null}
          {layer ? (
            <>
              <hr className="gs-sep" />
              <ThreadLinks rpc={rpc} view={view} layer={layer} currentThreadId={currentThreadId} />
            </>
          ) : null}
        </aside>
        <main className="gs-content" aria-label="Layer review">
          {incompleteLayers.length > 0 ? (
            <div role="alert" className="gs-alert gs-tone-warning gs-banner gs-incomplete">
              <div className="min-w-0">
                <strong>Incomplete Graphite stack</strong>
                <p>{incompleteLayers.length} {incompleteLayers.length === 1 ? "branch has" : "branches have"} an unavailable parent. Review available branches in the rail.</p>
                <details>
                  <summary>Show parent details</summary>
                  <p>Stack actions stay blocked until repair.</p>
                  <ul>
                    {incompleteLayers.map((item) => (
                      <li key={item.name}>{item.name} → {item.parent}</li>
                    ))}
                  </ul>
                </details>
              </div>
            </div>
          ) : null}
          {stoppedWorktrees.map((worktree) => (
            <div key={worktree.path} role="alert" className="gs-alert gs-tone-danger gs-banner">
              <Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <strong>
                  {worktree.operation} stopped on {worktree.branch ?? "a detached HEAD"}
                </strong>
                <div className="truncate font-mono text-[11px]">{worktree.path}</div>
                {worktree.conflicted > 0 ? <div className="text-[11px]">{worktree.conflicted} conflicted files</div> : null}
              </div>
              <Button size="sm" variant="outline" onClick={() => setOperation({ kind: "recover", worktreePath: worktree.path, action: "continue" })}>
                Continue…
              </Button>
              <Button size="sm" variant="outline" onClick={() => setOperation({ kind: "recover", worktreePath: worktree.path, action: "abort" })}>
                Abort…
              </Button>
            </div>
          ))}
          {lastOperation.data?.result ? (
            <div className="gs-pad">
              <LastOperation result={lastOperation.data.result} />
            </div>
          ) : null}
          {layer ? (
            <LayerPane
              key={layer.name}
              rpc={rpc}
              view={view}
              layer={layer}
              version={version}
              manual={manual}
              visible={visible}
              prMap={prMap}
              prStatus={prs.data?.status}
              prMessage={prs.data?.message ?? null}
              currentThreadId={currentThreadId}
              onOperation={setOperation}
            />
          ) : (
            <StatePanel title="No branches tracked">Create a branch, or track an existing branch with Graphite.</StatePanel>
          )}
        </main>
      </div>
      <OperationDialog rpc={rpc} view={view} initial={operation} onClose={() => setOperation(null)} onFinished={onFinished} />
    </Frame>
  );
}

function Frame({ view, toolbar, children }: { view?: StackView; toolbar?: ReactNode; children: ReactNode }) {
  const repoName = view?.repoRoot ? fileName(view.repoRoot) : null;
  return (
    <div className="gs-root">
      <header className="gs-appbar">
        <span className="gs-wordmark">
          <Icon name="Layers" className="size-4" aria-hidden />
          Graphite Stack
        </span>
        {repoName ? (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="truncate font-medium" title={view?.repoRoot ?? undefined}>
              {view?.remote ? `${view.remote.owner} / ${view.remote.repo}` : repoName}
            </span>
          </>
        ) : null}
        <span className="flex-1" />
        <div className="gs-appbar-tools">{toolbar}</div>
      </header>
      {children}
    </div>
  );
}

function LayerPane({
  rpc,
  view,
  layer,
  version,
  manual,
  visible,
  prMap,
  prStatus,
  prMessage,
  currentThreadId,
  onOperation,
}: {
  rpc: GraphiteRpc;
  view: StackView;
  layer: LayerView;
  version: number;
  manual: number;
  visible: boolean;
  prMap: Record<string, import("../lib/model").PrSummary>;
  prStatus: import("../lib/model").PrSourceStatus | undefined;
  prMessage: string | null;
  currentThreadId: string | null;
  onOperation: (request: OperationRequest) => void;
}) {
  const env = view.environmentId;
  const pr = prMap[layer.name] ?? null;
  const [tab, setTab] = useState<Tab>("changes");
  const [selection, setSelection] = useState<FileSelection>(null);
  const [inlineAnchor, setInlineAnchor] = useState<{ side: "old" | "new"; line: number } | null>(null);
  const [hideResolved, setHideResolved] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [patchText, setPatchText] = useState<string | null>(null);
  const worktree = worktreeFor(view, layer.name);
  // The repo watcher sees Git metadata only. Source edits do not touch it, so
  // poll the selected layer's worktree status while this view is visible.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible || !worktree) return;
    const id = setInterval(() => setTick((value) => value + 1), UNCOMMITTED_POLL_MS);
    return () => clearInterval(id);
  }, [visible, worktree?.path]);

  const files = useResource(
    layer.trunk ? null : `files:${env}:${layer.name}:${layer.headSha ?? "none"}`,
    () => rpc.call("layerFiles", { environmentId: env, branch: layer.name }),
    { enabled: visible, version },
  );
  const notes = useResource(layer.trunk ? null : `notes:${env}:${layer.name}`, () => rpc.call("notesList", { environmentId: env, branch: layer.name }), {
    enabled: visible,
    version,
  });
  const prThreads = useResource(
    layer.trunk ? null : `prthreads:${env}:${layer.name}`,
    () => rpc.call("prThreads", { environmentId: env, branch: layer.name }),
    // Without a PR, read only on the Comments tab, to show stored pending drafts.
    { enabled: visible && (prStatus === "ok" && pr !== null ? tab !== "commits" : tab === "comments"), version },
  );
  const uncommitted = useResource(
    worktree ? `unc:${env}:${worktree.path}` : null,
    () => rpc.call("uncommitted", { environmentId: env, worktreePath: worktree!.path }),
    { enabled: visible, version: version + tick },
  );

  const snapshot = files.data?.snapshot ?? null;
  const fileList = files.data?.files ?? [];
  const viewedSet = useMemo(
    () => new Set((files.data?.viewed ?? []).map((entry) => `${entry.path}\u0000${entry.fileKey}`)),
    [files.data?.viewed],
  );
  const isViewed = (file: ChangedFile) => viewedSet.has(`${file.path}\u0000${fileKey(file)}`);
  const viewedCount = fileList.filter(isViewed).length;

  // Keep the file selection valid.
  useEffect(() => {
    if (selection?.source === "uncommitted") {
      if (uncommitted.data && !uncommitted.data.files.some((file) => file.path === selection.path)) setSelection(null);
      return;
    }
    if (files.data === undefined) return;
    if (selection === null || !fileList.some((file) => file.path === selection.path)) {
      const first = fileList.find((file) => !isViewed(file)) ?? fileList[0];
      setSelection(first ? { source: "layer", path: first.path } : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.data, uncommitted.data]);

  const selectedFile = selection?.source === "layer" ? (fileList.find((file) => file.path === selection.path) ?? null) : null;
  const selectedUncommitted =
    selection?.source === "uncommitted" ? (uncommitted.data?.files.find((file) => file.path === selection.path) ?? null) : null;

  const [viewedBusy, setViewedBusy] = useState(false);
  const [viewedError, setViewedError] = useState<string | null>(null);
  const setViewed = async (file: ChangedFile, viewed: boolean) => {
    setViewedBusy(true);
    setViewedError(null);
    try {
      const result = await rpc.call("setViewed", { environmentId: env, branch: layer.name, path: file.path, fileKey: fileKey(file), viewed });
      if (files.data) files.set({ ...files.data, viewed: result.viewed });
      if (viewed) {
        const index = fileList.findIndex((item) => item.path === file.path);
        const next = fileList.slice(index + 1).find((item) => !viewedSet.has(`${item.path}\u0000${fileKey(item)}`));
        if (next) setSelection({ source: "layer", path: next.path });
      }
    } catch (cause) {
      setViewedError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setViewedBusy(false);
    }
  };

  const onPatch = useCallback((patch: string | null) => setPatchText(patch), []);
  const prUnavailable = layer.trunk ? "Trunk branches have no review." : prUnavailableReason(prStatus, prMessage, pr);
  // Private notes belong to the branch's linked thread only, never to the
  // thread that happens to host this panel.
  const noteThreadId = layer.link?.status === "valid" ? layer.link.threadId : null;
  const allNotes = notes.data?.notes ?? [];
  const threads = prThreads.data?.threads ?? [];
  const fileNotes = selectedFile ? allNotes.filter((note) => note.path === selectedFile.path && !note.delivery?.hidden) : [];
  const fileThreads = selectedFile ? threads.filter((thread) => thread.path === selectedFile.path) : [];
  const visibleNotes = allNotes.filter((note) => (showHidden || !note.delivery?.hidden) && (!hideResolved || !note.resolved));
  const visibleThreads = hideResolved ? threads.filter((thread) => !thread.isResolved) : threads;
  const openComments = allNotes.filter((note) => !note.resolved).length + threads.filter((thread) => !thread.isResolved).length;
  // One explanation for PR features. Prefer the fresher prThreads status.
  const reviewUnavailable = layer.trunk
    ? null
    : prThreads.data
      ? prUnavailableReason(prThreads.data.status, prThreads.data.message, prThreads.data.pr)
      : prUnavailable;
  const reloadComments = () => {
    notes.reload();
    prThreads.reload();
  };

  const title = pr?.title ?? layer.commits[0]?.subject ?? layer.name;
  const prState = pr ? prStateLabel(pr) : null;
  const checks = pr ? checksLabel(pr.checks) : null;
  const link = pr ? prLink(pr) : null;
  const moveFile = (delta: number) => {
    if (!selectedFile) return;
    const index = fileList.findIndex((file) => file.path === selectedFile.path);
    const next = fileList[index + delta];
    if (next) setSelection({ source: "layer", path: next.path });
  };

  return (
    <div className="gs-layer-pane">
      <header className="gs-layer-head">
        <h1>{title}</h1>
        <div className="gs-meta">
          {prState ? <Chip tone={prState.tone}>{prState.label}</Chip> : layer.trunk ? <Chip>Trunk</Chip> : <Chip>Local branch</Chip>}
          {checks ? <Chip tone={checks.tone}>{checks.label}</Chip> : null}
          {layer.needsRestack ? (
            <Chip tone="warning" icon="Repeat">
              Needs restack
            </Chip>
          ) : null}
          <span className="gs-branch">
            {layer.name}
            {layer.parent ? ` ← ${layer.parent}` : ""}
          </span>
          {worktree ? (
            <span className="gs-branch" title={worktree.path}>
              worktree {fileName(worktree.path)}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">Not checked out</span>
          )}
        </div>
        {!layer.trunk ? (
          <div className="gs-layer-actions">
            {link ? (
              <Button size="sm" variant="outline" asChild>
                <UrlLink href={link.url}>
                  <Icon name="ExternalLink" aria-hidden />
                  {link.label}
                </UrlLink>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={view.busyRepo} onClick={() => onOperation({ kind: "restack", branch: layer.name, scope: "upstack" })}>
              <Icon name="Repeat" aria-hidden />
              Restack…
            </Button>
            <Button size="sm" variant="outline" disabled={view.busyRepo} onClick={() => onOperation({ kind: "submit", branch: layer.name, stack: false })}>
              <Icon name="Sent" aria-hidden />
              Submit draft…
            </Button>
            {pr && prUnavailable === null ? (
              <Button size="sm" onClick={() => setTab("comments")}>
                Finish review
              </Button>
            ) : null}
          </div>
        ) : null}
        <div role="tablist" aria-label="Layer views" className="gs-tabs">
          {(["changes", "comments", "commits"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`gs-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`gs-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const order: Tab[] = ["changes", "comments", "commits"];
                const index = order.indexOf(id);
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  const next = order[(index + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length]!;
                  setTab(next);
                  document.getElementById(`gs-tab-${next}`)?.focus();
                }
              }}
            >
              {id === "changes" ? "Changes" : id === "comments" ? "Comments" : "Commits"}
              <span>{id === "changes" ? fileList.length : id === "comments" ? openComments : layer.detailsLoaded === false ? "…" : layer.commitCount}</span>
            </button>
          ))}
        </div>
      </header>

      {tab === "changes" ? (
        <section id="gs-panel-changes" role="tabpanel" aria-labelledby="gs-tab-changes" className="gs-panel">
          {layer.trunk ? (
            <StatePanel title="Trunk">Trunk branches have no Graphite parent. Select a branch to review its changes.</StatePanel>
          ) : (
            <>
              <div className="gs-reviewbar">
                <span className="text-muted-foreground">vs parent</span>
                <span className="gs-branch">{snapshot?.parent ?? layer.parent}</span>
                {snapshot ? (
                  <span className="gs-branch" title={`${snapshot.baseSha}..${snapshot.headSha}`}>
                    {shortSha(snapshot.baseSha)}..{shortSha(snapshot.headSha)}
                  </span>
                ) : null}
                {fileList.length > 0 ? (
                  <span className="text-muted-foreground">
                    {viewedCount} of {fileList.length} viewed
                  </span>
                ) : null}
                <span className="flex-1" />
              </div>
              {snapshot?.diverged ? (
                <div className="gs-pad">
                  <Notice>
                    {snapshot.parent} moved after this branch was stacked on it. The diff compares against the merge base. Restack to
                    rebase on the current parent.
                  </Notice>
                </div>
              ) : null}
              {files.error ? (
                <div className="gs-pad">
                  <InlineError onRetry={files.reload}>{files.error}</InlineError>
                </div>
              ) : null}
              {files.data?.error ? (
                <div className="gs-pad">
                  <InlineError onRetry={files.reload}>{files.data.error}</InlineError>
                </div>
              ) : null}
              <div className="gs-changes">
                <FileNav
                  files={fileList}
                  truncated={files.data?.truncated ?? false}
                  loading={files.loading && files.data === undefined}
                  isViewed={isViewed}
                  selection={selection}
                  onSelect={setSelection}
                  uncommitted={uncommitted.data?.files ?? null}
                  uncommittedError={uncommitted.error ?? uncommitted.data?.error ?? null}
                  worktreePath={worktree?.path ?? null}
                />
                <div className="gs-diff-column">
                  {viewedError ? <InlineError>{viewedError}</InlineError> : null}
                  {selectedFile && snapshot ? (
                    <>
                      <div className="gs-file-nav-buttons">
                        <Button size="sm" variant="ghost" aria-label="Previous file" disabled={fileList[0]?.path === selectedFile.path} onClick={() => moveFile(-1)}>
                          <Icon name="ChevronUp" aria-hidden />
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Next file" disabled={fileList[fileList.length - 1]?.path === selectedFile.path} onClick={() => moveFile(1)}>
                          <Icon name="ChevronDown" aria-hidden />
                        </Button>
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{fileDir(selectedFile.path)}</span>
                      </div>
                      <FileDiff
                        key={`${snapshot.baseSha}:${snapshot.headSha}:${selectedFile.path}`}
                        resourceKey={`${env}:${snapshot.baseSha}:${snapshot.headSha}:${selectedFile.path}`}
                        // Committed patches are immutable per SHA pair. Reload only on request.
                        version={manual}
                        path={selectedFile.path}
                        oldPath={selectedFile.oldPath}
                        kind={fileKind(selectedFile)}
                        additions={selectedFile.additions}
                        deletions={selectedFile.deletions}
                        loadPatch={() =>
                          rpc.call("filePatch", {
                            environmentId: env,
                            baseSha: snapshot.baseSha,
                            headSha: snapshot.headSha,
                            path: selectedFile.path,
                            oldPath: selectedFile.oldPath,
                          })
                        }
                        loadSides={() =>
                          rpc.call("fileSides", {
                            environmentId: env,
                            baseSha: snapshot.baseSha,
                            headSha: snapshot.headSha,
                            path: selectedFile.path,
                            oldPath: selectedFile.oldPath,
                          })
                        }
                        viewed={{ value: isViewed(selectedFile), busy: viewedBusy, onChange: (value) => void setViewed(selectedFile, value) }}
                        onPatch={onPatch}
                        inlineReview={view.repoKey && !selectedFile.binary ? {
                          onAdd: (side, line) => setInlineAnchor({ side, line }),
                          renderLine: (side, line) => <div className="gs-inline-comments">
                            <NoteList rpc={rpc} environmentId={env} notes={fileNotes.filter((note) => note.side === side && note.endLine === line)} currentHeadSha={snapshot.headSha} onChanged={notes.reload} />
                            {inlineAnchor?.side === side && inlineAnchor.line === line ? <LineComposer key={`${layer.name}:${selectedFile.path}:${side}:${line}`} rpc={rpc} environmentId={env} repoKey={view.repoKey!} branch={layer.name} path={selectedFile.path} snapshot={snapshot} patch={patchText} noteThreadId={noteThreadId} prAvailability={prUnavailable} initialAnchor={inlineAnchor} onClose={() => setInlineAnchor(null)} onSaved={(destination) => { setInlineAnchor(null); destination === "private" ? notes.reload() : prThreads.reload(); }} /> : null}
                          </div>,
                        } : undefined}
                      />
                      {view.repoKey && !selectedFile.binary ? (
                        <LineComposer
                          key={`${layer.name}:${selectedFile.path}`}
                          rpc={rpc}
                          environmentId={env}
                          repoKey={view.repoKey}
                          branch={layer.name}
                          path={selectedFile.path}
                          snapshot={snapshot}
                          patch={patchText}
                          noteThreadId={noteThreadId}
                          prAvailability={prUnavailable}
                          onSaved={(destination) => (destination === "private" ? notes.reload() : prThreads.reload())}
                        />
                      ) : null}
                      {fileNotes.length > 0 || fileThreads.length > 0 ? (
                        <div className="gs-file-comments" aria-label={`Comments on ${selectedFile.path}`}>
                          <h3 className="gs-subhead">All comments for this file</h3>
                          <NoteList rpc={rpc} environmentId={env} notes={fileNotes} currentHeadSha={snapshot.headSha} onChanged={notes.reload} />
                          {fileThreads.length > 0 ? (
                            <PrThreads rpc={rpc} environmentId={env} branch={layer.name} threads={fileThreads} truncated={false} onChanged={prThreads.reload} />
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : selectedUncommitted && worktree ? (
                    <>
                      <Notice icon="Info">
                        Uncommitted change in {worktree.path}. It is not part of this layer, and comments need a commit.
                      </Notice>
                      <FileDiff
                        key={`unc:${worktree.path}:${selectedUncommitted.path}:${uncommitted.data?.headSha ?? ""}`}
                        resourceKey={`unc:${env}:${worktree.path}:${selectedUncommitted.path}`}
                        version={version + tick}
                        path={selectedUncommitted.path}
                        oldPath={selectedUncommitted.oldPath}
                        kind={selectedUncommitted.conflicted ? "conflict" : selectedUncommitted.untracked ? "added" : "modified"}
                        additions={null}
                        deletions={null}
                        loadPatch={() =>
                          rpc.call("uncommittedPatch", {
                            environmentId: env,
                            worktreePath: worktree.path,
                            path: selectedUncommitted.path,
                            untracked: selectedUncommitted.untracked,
                          })
                        }
                      />
                    </>
                  ) : files.data && fileList.length === 0 && !files.data.error ? (
                    <StatePanel title="No committed changes">This branch has no changes against {layer.parent ?? "its parent"}.</StatePanel>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      {tab === "comments" ? (
        <section id="gs-panel-comments" role="tabpanel" aria-labelledby="gs-tab-comments" className="gs-panel gs-pad gs-comments">
          <div className="flex items-center gap-2">
            <SectionLabel>All comments</SectionLabel>
            <span className="flex-1" />
            <label className="gs-check">
              <input type="checkbox" checked={hideResolved} onChange={(event) => setHideResolved(event.target.checked)} />
              Hide resolved
            </label>
          </div>
          {layer.trunk ? <p className="text-xs text-muted-foreground">Trunk branches have no comments.</p> : null}
          {notes.error ? <InlineError onRetry={notes.reload}>{notes.error}</InlineError> : null}
          <ThreadReview rpc={rpc} environmentId={env} branch={layer.name} threadId={noteThreadId} notes={allNotes} onChanged={notes.reload} />
          <label className="gs-check"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> Show locally hidden comments</label>
          <h3 className="gs-subhead">Local and thread comments</h3>
          {notes.data?.truncated ? <p className="text-[11px] text-muted-foreground">Older notes are not shown.</p> : null}
          <NoteList
            rpc={rpc}
            environmentId={env}
            notes={visibleNotes}
            currentHeadSha={snapshot?.headSha ?? notes.data?.snapshot?.headSha ?? null}
            emptyText={notes.loading ? "Loading notes…" : "No local comments."}
            onChanged={notes.reload}
          />
          <h3 className="gs-subhead">Pull request threads</h3>
          {reviewUnavailable ? <p className="text-xs text-muted-foreground">{reviewUnavailable}</p> : null}
          {prThreads.error ? <InlineError onRetry={prThreads.reload}>{prThreads.error}</InlineError> : null}
          {prThreads.loading && !prThreads.data ? <Spinner label="Loading pull request threads…" /> : null}
          {prThreads.data?.status === "ok" && prThreads.data.pr ? (
            <PrThreads
              rpc={rpc}
              environmentId={env}
              branch={layer.name}
              threads={visibleThreads}
              truncated={prThreads.data.truncated}
              onChanged={prThreads.reload}
            />
          ) : null}
          {!layer.trunk ? (
            <FinishReview
              key={layer.name}
              rpc={rpc}
              environmentId={env}
              branch={layer.name}
              pr={pr}
              pending={prThreads.data?.pending ?? null}
              unavailable={reviewUnavailable}
              onChanged={prThreads.reload}
              onPending={(pending) => {
                if (prThreads.data) prThreads.set({ ...prThreads.data, pending });
              }}
            />
          ) : null}
        </section>
      ) : null}

      {tab === "commits" ? (
        <section id="gs-panel-commits" role="tabpanel" aria-labelledby="gs-tab-commits" className="gs-panel gs-pad">
          {layer.detailsLoaded === false ? (
            <p className="text-xs text-muted-foreground">Loading commits…</p>
          ) : layer.commits.length === 0 ? (
            <p className="text-xs text-muted-foreground">No commits in this layer.</p>
          ) : (
            <ol className="gs-commits">
              {layer.commits.map((commit) => (
                <li key={commit.sha}>
                  <span className="font-mono text-[11px] text-muted-foreground">{shortSha(commit.sha)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs">{commit.subject}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {commit.author} · {relativeTime(commit.time * 1000)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {layer.commitsTruncated ? <p className="pt-2 text-[11px] text-muted-foreground">Older commits are not shown.</p> : null}
        </section>
      ) : null}
    </div>
  );
}

function FileNav({
  files,
  truncated,
  loading,
  isViewed,
  selection,
  onSelect,
  uncommitted,
  uncommittedError,
  worktreePath,
}: {
  files: ChangedFile[];
  truncated: boolean;
  loading: boolean;
  isViewed: (file: ChangedFile) => boolean;
  selection: FileSelection;
  onSelect: (selection: FileSelection) => void;
  uncommitted: UncommittedFile[] | null;
  uncommittedError: string | null;
  worktreePath: string | null;
}) {
  return (
    <nav className="gs-filenav" aria-label="Changed files">
      <label className="gs-file-select">
        <span className="sr-only">Changed file</span>
        <select
          value={selection ? `${selection.source}\u0000${selection.path}` : ""}
          onChange={(event) => {
            const [source, path] = event.target.value.split("\u0000");
            if (path) onSelect({ source: source === "uncommitted" ? "uncommitted" : "layer", path });
          }}
        >
          {files.map((file) => (
            <option key={file.path} value={`layer\u0000${file.path}`}>
              {isViewed(file) ? "✓ " : ""}
              {file.path}
            </option>
          ))}
          {(uncommitted ?? []).map((file) => (
            <option key={`u-${file.path}`} value={`uncommitted\u0000${file.path}`}>
              Uncommitted: {file.path}
            </option>
          ))}
        </select>
      </label>
      <div className="gs-file-list">
        <SectionLabel trailing={<span>{files.length}</span>}>Layer changes</SectionLabel>
        {loading ? <Spinner label="Loading files…" /> : null}
        <ul>
          {files.map((file) => {
            const active = selection?.source === "layer" && selection.path === file.path;
            const viewed = isViewed(file);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className={cn("gs-filelink", active && "gs-filelink-active", viewed && "gs-filelink-viewed")}
                  aria-current={active ? "true" : undefined}
                  title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  onClick={() => onSelect({ source: "layer", path: file.path })}
                >
                  <span className={cn("gs-status", `gs-status-${file.status}`)} aria-label={`Status ${file.status}`}>
                    {file.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
                  {viewed ? <Icon name="Check" className="size-3 text-muted-foreground" aria-label="Viewed" /> : null}
                  {file.binary ? (
                    <span className="text-[10px] text-muted-foreground">bin</span>
                  ) : file.additions !== null ? (
                    <span className="gs-stats">
                      <span className="gs-add">+{file.additions}</span> <span className="gs-del">−{file.deletions ?? 0}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        {truncated ? <p className="gs-side-note">More files changed than BB lists.</p> : null}
        {worktreePath && (uncommitted?.length || uncommittedError) ? (
          <>
            <SectionLabel trailing={<span>{uncommitted?.length ?? 0}</span>}>Uncommitted</SectionLabel>
            {uncommittedError ? <p className="gs-side-note text-destructive">{uncommittedError}</p> : null}
            <ul>
              {(uncommitted ?? []).map((file) => {
                const active = selection?.source === "uncommitted" && selection.path === file.path;
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={cn("gs-filelink", active && "gs-filelink-active")}
                      aria-current={active ? "true" : undefined}
                      title={file.path}
                      onClick={() => onSelect({ source: "uncommitted", path: file.path })}
                    >
                      <span className="gs-status" aria-label={file.untracked ? "Untracked" : `Index ${file.index}, worktree ${file.worktree}`}>
                        {file.conflicted ? "!" : file.untracked ? "?" : (file.worktree.trim() || file.index.trim() || "M")}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </nav>
  );
}
