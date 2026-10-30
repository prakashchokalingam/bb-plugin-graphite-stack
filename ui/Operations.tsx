// Graphite mutations: every action shows a preview from the server (affected
// branches, blockers, warnings, token) before the user runs it.
import { useEffect, useRef, useState } from "react";
import type { OperationPreview, OperationRequest, OperationResult, OperationStep, StackView } from "../contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Chip, InlineError, Notice, Segmented, Spinner } from "./primitives";
import { errorMessage, relativeTime, type Tone } from "./model";
import type { GraphiteRpc } from "./rpc";

const STEP_TONE: Record<OperationStep["status"], Tone> = {
  pending: "muted",
  done: "success",
  "up-to-date": "muted",
  "skipped-by-gt": "warning",
  blocked: "danger",
  conflict: "danger",
  failed: "danger",
};

const STEP_LABEL: Record<OperationStep["status"], string> = {
  pending: "Pending",
  done: "Done",
  "up-to-date": "Up to date",
  "skipped-by-gt": "Skipped by gt",
  blocked: "Blocked",
  conflict: "Conflict",
  failed: "Failed",
};

const OUTCOME: Record<OperationResult["outcome"], { label: string; tone: Tone }> = {
  success: { label: "Succeeded", tone: "success" },
  partial: { label: "Partly done", tone: "warning" },
  conflict: { label: "Stopped at a conflict", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Not run", tone: "warning" },
};

export function StepList({ steps }: { steps: OperationStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="gs-steps" aria-label="Affected branches">
      {steps.map((step, index) => (
        <li key={`${step.branch ?? "repo"}-${index}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-medium">{step.branch ?? "repository"}</span>
            <Chip tone={STEP_TONE[step.status]}>{STEP_LABEL[step.status]}</Chip>
            {step.worktreePath ? (
              <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={step.worktreePath}>
                in {step.worktreePath}
              </span>
            ) : null}
          </div>
          {step.argv.length > 0 ? <code className="gs-argv">{step.argv.join(" ")}</code> : null}
          {step.message ? <p className="text-[11px] text-muted-foreground">{step.message}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function OperationDialog({
  rpc,
  view,
  initial,
  onClose,
  onFinished,
}: {
  rpc: GraphiteRpc;
  view: StackView;
  initial: OperationRequest | null;
  onClose: () => void;
  onFinished: (result: OperationResult) => void;
}) {
  const [request, setRequest] = useState<OperationRequest | null>(initial);
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    setRequest(initial);
    setPreview(null);
    setResult(null);
    setError(null);
  }, [initial]);

  const needsInput = request !== null && (request.kind === "create" || request.kind === "track" || request.kind === "init");
  const inputReady =
    request === null
      ? false
      : request.kind === "create"
        ? request.name.trim() !== "" && request.message.trim() !== ""
        : request.kind === "track"
          ? request.parent.trim() !== ""
          : request.kind === "init"
            ? request.trunk.trim() !== ""
            : true;

  const runPreview = async (target: OperationRequest) => {
    const id = ++sequence.current;
    setPreviewing(true);
    setPreview(null);
    setError(null);
    try {
      const next = await rpc.call("previewOperation", { environmentId: view.environmentId, request: target });
      if (id === sequence.current) setPreview(next);
    } catch (cause) {
      if (id === sequence.current) setError(errorMessage(cause));
    } finally {
      if (id === sequence.current) setPreviewing(false);
    }
  };

  // Preview at once for actions without free text input.
  useEffect(() => {
    if (request && !needsInput && result === null) void runPreview(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const edit = (next: OperationRequest) => {
    sequence.current += 1;
    setPreview(null);
    setPreviewing(false);
    setRequest(next);
  };

  const run = async () => {
    if (!request || !preview || !preview.allowed) return;
    setRunning(true);
    setError(null);
    try {
      const outcome = await rpc.call("runOperation", { environmentId: view.environmentId, request, token: preview.token });
      setResult(outcome);
      onFinished(outcome);
    } catch (cause) {
      // Do not retry: the operation state is unknown until the stack reloads.
      setError(`${errorMessage(cause)} Reload the stack to see the current state before you run it again.`);
    } finally {
      setRunning(false);
    }
  };

  const conflictWorktree =
    result?.steps.find((step) => step.status === "conflict" && step.worktreePath !== null)?.worktreePath ?? null;

  return (
    <Dialog open={initial !== null} onOpenChange={(open) => (!open && !running ? onClose() : undefined)}>
      <DialogContent className="gs-dialog">
        <DialogHeader>
          <DialogTitle>{preview?.title ?? result?.summary ?? titleFor(request)}</DialogTitle>
          <DialogDescription>
            {result
              ? "The operation finished. Review each branch below."
              : "Review the affected branches. Nothing changes until you select Run."}
          </DialogDescription>
        </DialogHeader>
        <div className="gs-dialog-body">
          {request && needsInput && result === null ? <RequestForm view={view} request={request} onChange={edit} /> : null}
          {request?.kind === "restack" && result === null ? (
            <RestackScope value={request.scope} onChange={(scope) => edit({ ...request, scope })} />
          ) : null}
          {request?.kind === "submit" && result === null ? (
            <Segmented
              label="Submit scope"
              value={request.stack ? "stack" : "branch"}
              options={[
                { value: "branch", label: "Branch and downstack" },
                { value: "stack", label: "Whole stack" },
              ]}
              onChange={(scope) => edit({ ...request, stack: scope === "stack" })}
            />
          ) : null}
          {previewing ? <Spinner label="Preparing preview…" /> : null}
          {error ? <InlineError>{error}</InlineError> : null}
          {preview && result === null ? (
            <>
              {preview.blockers.length > 0 ? (
                <div role="alert" className="gs-alert gs-tone-danger">
                  <Icon name="CircleX" className="size-4 shrink-0" aria-hidden />
                  <ul className="list-disc pl-4">
                    {preview.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.warnings.length > 0 ? (
                <Notice>
                  <ul className="list-disc pl-4">
                    {preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              <StepList steps={preview.steps} />
              {preview.dryRunOutput ? (
                <details className="gs-details">
                  <summary>Dry-run output</summary>
                  <pre>{preview.dryRunOutput}</pre>
                </details>
              ) : null}
            </>
          ) : null}
          {result ? <ResultView result={result} /> : null}
          {result?.outcome === "conflict" && conflictWorktree ? (
            <Notice tone="danger" icon="AlertTriangle">
              Resolve the conflicted files in {conflictWorktree} and stage them. Then continue, or abort to return the branch to its
              earlier state.
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { setResult(null); edit({ kind: "recover", worktreePath: conflictWorktree, action: "continue" }); }}>
                  Continue…
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setResult(null); edit({ kind: "recover", worktreePath: conflictWorktree, action: "abort" }); }}>
                  Abort…
                </Button>
              </div>
            </Notice>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={running} onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {result === null ? (
            needsInput && preview === null ? (
              <Button disabled={!inputReady || previewing} onClick={() => request && void runPreview(request)}>
                Preview
              </Button>
            ) : (
              <Button disabled={!preview?.allowed || running || previewing} onClick={() => void run()}>
                {running ? "Running…" : "Run"}
              </Button>
            )
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function titleFor(request: OperationRequest | null): string {
  switch (request?.kind) {
    case "init":
      return "Initialize Graphite";
    case "create":
      return "Create a branch";
    case "track":
      return "Track a branch";
    case "restack":
      return "Restack";
    case "sync":
      return "Sync with remote";
    case "submit":
      return "Submit as draft pull requests";
    case "recover":
      return request.action === "continue" ? "Continue the stopped operation" : "Abort the stopped operation";
    default:
      return "Graphite action";
  }
}

function ResultView({ result }: { result: OperationResult }) {
  const outcome = OUTCOME[result.outcome];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={outcome.tone}>{outcome.label}</Chip>
        <span className="text-xs">{result.summary}</span>
      </div>
      <StepList steps={result.steps} />
      {result.output ? (
        <details className="gs-details">
          <summary>Command output</summary>
          <pre>{result.output}</pre>
        </details>
      ) : null}
    </div>
  );
}

function RequestForm({
  view,
  request,
  onChange,
}: {
  view: StackView;
  request: OperationRequest;
  onChange: (request: OperationRequest) => void;
}) {
  if (request.kind === "create") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          gt create makes a branch on top of {view.currentBranch ?? "the current branch"} in {view.repoRoot ?? "this worktree"} and
          commits the staged changes.
        </p>
        <label className="gs-field gs-field-wide">
          <span>Branch name</span>
          <input value={request.name} onChange={(event) => onChange({ ...request, name: event.target.value.trim() })} />
        </label>
        <label className="gs-field gs-field-wide">
          <span>Commit message</span>
          <textarea className="gs-textarea" rows={2} value={request.message} onChange={(event) => onChange({ ...request, message: event.target.value })} />
        </label>
        <label className="gs-check">
          <input type="checkbox" checked={request.stageAll} onChange={(event) => onChange({ ...request, stageAll: event.target.checked })} />
          Stage all changes first (gt create --all)
        </label>
      </div>
    );
  }
  if (request.kind === "track") {
    const parents = [...view.trunks, ...view.layers.filter((layer) => !layer.trunk).map((layer) => layer.name)].filter(
      (name) => name !== request.branch,
    );
    return (
      <label className="gs-field gs-field-wide">
        <span>Graphite parent of {request.branch}</span>
        <select value={request.parent} onChange={(event) => onChange({ ...request, parent: event.target.value })}>
          <option value="">Select a parent…</option>
          {parents.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (request.kind === "init") {
    return (
      <label className="gs-field gs-field-wide">
        <span>Trunk branch</span>
        <select value={request.trunk} onChange={(event) => onChange({ ...request, trunk: event.target.value })}>
          <option value="">Select the trunk…</option>
          {view.localBranches.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return null;
}

/** Restack scope picker shown before the restack preview. */
export function RestackScope({
  value,
  onChange,
}: {
  value: "only" | "upstack" | "stack";
  onChange: (value: "only" | "upstack" | "stack") => void;
}) {
  return (
    <Segmented
      label="Restack scope"
      value={value}
      options={[
        { value: "only", label: "This branch" },
        { value: "upstack", label: "Upstack" },
        { value: "stack", label: "Whole stack" },
      ]}
      onChange={onChange}
    />
  );
}

export function LastOperation({ result }: { result: OperationResult }) {
  const outcome = OUTCOME[result.outcome];
  return (
    <details className="gs-last-op">
      <summary>
        <Chip tone={outcome.tone}>{outcome.label}</Chip>
        <span className="min-w-0 flex-1 truncate">{result.summary}</span>
        <span className="text-[10px] text-muted-foreground">{relativeTime(result.finishedAt)}</span>
      </summary>
      <div className="pt-2">
        <StepList steps={result.steps} />
      </div>
    </details>
  );
}
