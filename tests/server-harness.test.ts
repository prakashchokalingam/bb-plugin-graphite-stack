// Wires server.ts to the real host entry through the SDK fake host. Only
// BB thread/environment identity comes from fixtures; git and gt are real.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createHostEntry } from "../host";
import type { Runner } from "../lib/process";
import plugin from "../server";
import { testRunner } from "./helpers";

export function makeEnvironment(id: string, envPath: string, projectId = "proj_1", hostId = "host_1") {
  return {
    baseBranch: null,
    branchName: null,
    createdAt: 1,
    defaultBranch: "main",
    environmentProviderId: null,
    environmentProviderInstanceKey: null,
    environmentProviderSelection: null,
    hostId,
    hostLifecycle: "active" as const,
    id,
    isGitRepo: true,
    isWorktree: false,
    lifecycle: { phase: "active" as const, retireAt: null, teardown: null },
    managed: false,
    mergeBaseBranch: null,
    name: id,
    path: envPath,
    projectId,
    status: "ready" as const,
    updatedAt: 1,
    workspaceProvisionType: "unmanaged" as const,
  };
}

export type Env = ReturnType<typeof makeEnvironment>;
export type ThreadFixture = ReturnType<typeof makeThreadResponse>;

export interface World {
  environments: Map<string, Env>;
  threads: Map<string, ThreadFixture>;
  running: Set<string>;
  send?: (input: unknown) => Promise<{ ok: true; delivery: "sent" }>;
}

export async function startServer(world: World, runner: Runner = testRunner) {
  const hostHarness = experimental_createHostEntryHarness(createHostEntry(runner), {
    experimental_watch: async () => ({ dispose: async () => {} }),
  });
  const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });
  const { bb, harness } = createFakePluginHost({
    pluginId: "graphite-stack",
    experimental_hostEntry: true,
    sdk: {
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          const environment = world.environments.get(environmentId);
          if (environment === undefined) throw notFound("Environment");
          return environment;
        },
        list: async ({ projectId, hostId }: { projectId?: string; hostId?: string }) =>
          [...world.environments.values()].filter(
            (environment) => (projectId === undefined || environment.projectId === projectId) && (hostId === undefined || environment.hostId === hostId),
          ),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = world.threads.get(threadId);
          if (thread === undefined) throw notFound("Thread");
          return thread;
        },
        list: async ({ projectId }: { projectId?: string }) =>
          [...world.threads.values()].filter((thread) => projectId === undefined || thread.projectId === projectId),
        send: async (input: unknown) => { if (!world.send) throw new Error("send not stubbed"); return world.send(input); },
        listRunning: async () =>
          [...world.running].map((id) => ({ id, hostId: world.environments.get(world.threads.get(id)?.environmentId ?? "")?.hostId ?? null })),
      },
    } as never,
    experimental_callHostRpc: ({ method, input, signal }) =>
      hostHarness.experimental_call(method as never, input as never, signal ? { signal } : undefined),
  });
  await plugin(bb);
  const call = <T = any>(method: string, input?: unknown) => harness.behavior.callRpc(method, input) as Promise<T>;
  return {
    bb,
    harness,
    call,
    dispose: async () => {
      await harness.lifecycle.dispose();
      await hostHarness.experimental_dispose();
    },
  };
}

export function thread(id: string, environmentId: string | null, overrides: Partial<ThreadFixture> = {}): ThreadFixture {
  return makeThreadResponse({ id, environmentId, projectId: "proj_1", title: `Thread ${id}`, ...overrides });
}

// This file is named *.test.ts so the public-SDK scanner treats its testing
// imports as test code. It also checks the wiring itself.
import { describe, expect, it } from "vitest";

describe("server harness", () => {
  it("registers every RPC method and the CLI", async () => {
    const server = await startServer({ environments: new Map(), threads: new Map(), running: new Set() });
    try {
      const methods = server.harness.registrations.rpcMethods.map((method: { name?: string } | string) => (typeof method === "string" ? method : method.name));
      expect(methods).toContain("stack");
      expect(methods).toContain("runOperation");
      expect(server.harness.registrations.cli).not.toBeNull();
    } finally {
      await server.dispose();
    }
  });
});
