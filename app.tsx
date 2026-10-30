// Graphite Stack — BB plugin frontend entry.
//
// Two surfaces share one review workspace (ui/GraphiteView.tsx):
// - a fixed "Graphite" tab beside every thread, anchored on the thread's
//   environment;
// - a "Graphite stacks" project page that lists the project's repositories
//   (projectRepos) and opens one of them.
//
// React and @get-bb/plugin-sdk/app come from the BB app at load time. The app
// imports only types from contract.ts and lib/model.ts.
import { useEffect, useState } from "react";
import type { ExperimentalThreadTabProps, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, experimental_useTabVisible, useBbContext, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { GraphiteView } from "./ui/GraphiteView";
import { InlineError, Spinner, StatePanel } from "./ui/primitives";
import { statusCopy } from "./ui/model";
import { useGraphiteRpc, useResource } from "./ui/rpc";
import "./app.css";

export const NAV_PATH = "stacks";

export function ThreadGraphiteTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const visible = experimental_useTabVisible();
  if (!environment) {
    return (
      <div className="gs-root">
        <StatePanel title="No environment">
          This thread has no BB environment. Graphite Stack reads the Git checkout of a thread environment.
        </StatePanel>
      </div>
    );
  }
  return <GraphiteView environmentId={environment.id} currentThreadId={threadId} visible={visible} />;
}

/** True while the document is visible. Plugin pages have no tab visibility. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function decodeSegments(subPath: string): string[] {
  return subPath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function ProjectStacksPage({ subPath }: PluginNavPanelProps) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const rpc = useGraphiteRpc();
  const visible = usePageVisible();
  const [routeProject, routeRepo] = decodeSegments(subPath);
  const projectId = routeProject ?? context.projectId ?? null;

  const projects = useResource("projects", async () => {
    const list = await sdk.projects.list();
    return list.map((project) => ({ id: project.id, name: project.name }));
  });
  const repos = useResource(projectId ? `repos:${projectId}` : null, () => rpc.call("projectRepos", { projectId: projectId! }), {
    enabled: visible,
  });

  const go = (project: string | null, repo: string | null) => {
    const parts = [project, repo].filter((part): part is string => part !== null).map(encodeURIComponent);
    navigate.toPluginPanel(NAV_PATH, { subPath: parts.join("/") });
  };

  const repoList = repos.data?.repos ?? [];
  const repo = repoList.find((item) => item.key === routeRepo) ?? (repoList.length === 1 ? repoList[0] : undefined);

  const toolbar = (
    <>
      <label className="gs-picker">
        <span className="sr-only">Project</span>
        <select value={projectId ?? ""} onChange={(event) => go(event.target.value || null, null)}>
          <option value="">Select a project…</option>
          {(projects.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {repoList.length > 1 ? (
        <label className="gs-picker">
          <span className="sr-only">Repository</span>
          <select value={repo?.key ?? ""} onChange={(event) => go(projectId, event.target.value || null)}>
            <option value="">Select a repository…</option>
            {repoList.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );

  if (projectId && repo) {
    return <GraphiteView key={repo.environmentId} environmentId={repo.environmentId} currentThreadId={null} visible={visible} toolbar={toolbar} />;
  }

  return (
    <div className="gs-root">
      <header className="gs-appbar">
        <span className="gs-wordmark">Graphite Stack</span>
        <span className="flex-1" />
        <div className="gs-appbar-tools">{toolbar}</div>
      </header>
      {projects.error ? <InlineError onRetry={projects.reload}>{projects.error}</InlineError> : null}
      {!projectId ? (
        <StatePanel title="Select a project">Graphite Stack lists the Git repositories of the project environments.</StatePanel>
      ) : repos.loading && !repos.data ? (
        <div className="p-6">
          <Spinner label="Finding repositories…" />
        </div>
      ) : repos.error ? (
        <StatePanel
          icon="AlertTriangle"
          title="Cannot list repositories"
          actions={
            <Button size="sm" variant="outline" onClick={repos.reload}>
              Retry
            </Button>
          }
        >
          {repos.error}
        </StatePanel>
      ) : repoList.length === 0 ? (
        <StatePanel title="No Git repositories">
          No environment of this project is a Git checkout.
          {repos.data && repos.data.environmentsWithoutGit > 0
            ? ` ${repos.data.environmentsWithoutGit} environments have no Git repository.`
            : " Start a thread in this project to create an environment."}
        </StatePanel>
      ) : (
        <ul className="gs-repo-list" aria-label="Repositories">
          {repoList.map((item) => (
            <li key={item.key}>
              <button type="button" className="gs-repo" onClick={() => go(projectId, item.key)}>
                <span className="font-medium">{item.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {item.status === "ready" ? `${item.environmentIds.length} environments` : statusCopy(item.status).title}
                  {item.message ? ` · ${item.message}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "graphite",
    title: "Graphite",
    icon: "graphite-stack/stack",
    component: ThreadGraphiteTab,
    layout: "flush",
  });
  app.slots.navPanel({
    id: "stacks",
    title: "Graphite stacks",
    icon: "graphite-stack/stack",
    path: NAV_PATH,
    component: ProjectStacksPage,
  });
});
