import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunRequired, listCallsForRun, migrations } from "./data.js";
import { createWorkflowService } from "./service.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";

function source(body: string, name = "lane-test"): string {
  return `export const meta = {
  name: ${JSON.stringify(name)},
  description: "Lane placement test",
};
${body}`;
}

interface WorkspaceState {
  uncommittedFiles: string[];
  changedFiles: number;
  branchName: string;
  headSha?: string;
}

interface LaneSetupOptions {
  originUncommitted?: string[];
  workspaces?: Record<string, Partial<WorkspaceState>>;
  workerProvider?: Record<string, string>;
  unavailableStatus?: "unavailable" | "not_applicable" | "unknown" | "throw";
  sendError?: string;
  continuationUncommitted?: string[];
  workerState?: Record<string, { status?: string; projectId?: string; environmentId?: string }>;
}

function setup(options: LaneSetupOptions = {}) {
  let childCount = 0;
  const workerEnvironments = new Map<string, string>();
  const workerReads = new Map<string, number>();
  const commits: string[] = [];
  const archivedEnvironments: string[] = [];
  const deletedEnvironments: string[] = [];
  const workspaces = new Map<string, WorkspaceState>([
    [
      "environment-origin",
      {
        uncommittedFiles: options.originUncommitted ?? [],
        changedFiles: 0,
        branchName: "feature/orchestrator",
      },
    ],
  ]);
  for (const [environmentId, state] of Object.entries(
    options.workspaces ?? {},
  )) {
    workspaces.set(environmentId, {
      uncommittedFiles: state.uncommittedFiles ?? [],
      changedFiles: state.changedFiles ?? 1,
      branchName: state.branchName ?? `bb/${environmentId}`,
    });
  }

  const { bb, harness } = createFakePluginHost({
    pluginId: "workflows",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (threadId === "origin") {
            return {
              id: threadId,
              environmentId: "environment-origin",
              providerId: "codex",
              status: "idle",
            } as never;
          }
          const reads = (workerReads.get(threadId) ?? 0) + 1;
          workerReads.set(threadId, reads);
          const state = reads >= 3 ? options.workerState?.[threadId] : undefined;
          return {
            id: threadId,
            projectId: state?.projectId ?? "project-test",
            archivedAt: null,
            environmentId: state?.environmentId ?? workerEnvironments.get(threadId) ?? null,
            providerId: options.workerProvider?.[threadId] ?? "codex",
            status: state?.status ?? "idle",
          } as never;
        },
        output: async () => ({ output: "done" }),
        defaultExecutionOptions: async () => ({
          model: "gpt-test",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "default",
        }),
        spawn: async (input) => {
          childCount += 1;
          const id = `child-${childCount}`;
          const environment = input.environment as
            | { type: "reuse"; environmentId: string }
            | { type: "host" };
          if (environment.type === "reuse") {
            workerEnvironments.set(id, environment.environmentId);
          } else {
            const provisioned = `environment-lane-${childCount}`;
            workerEnvironments.set(id, provisioned);
            if (!workspaces.has(provisioned)) {
              workspaces.set(provisioned, {
                uncommittedFiles: [],
                changedFiles: 1,
                branchName: `bb/lane-${childCount}`,
              });
            }
          }
          return { id, environmentId: workerEnvironments.get(id) } as never;
        },
        send: async ({ threadId }) => {
          if (options.sendError) throw new Error(options.sendError);
          const environmentId = workerEnvironments.get(threadId);
          const workspace = environmentId === undefined ? undefined : workspaces.get(environmentId);
          if (workspace && options.continuationUncommitted) {
            workspace.uncommittedFiles = options.continuationUncommitted;
          }
          return { ok: true } as never;
        },
        stop: async () => ({ ok: true }) as never,
        archive: async () => ({ ok: true }) as never,
      },
      providers: {
        list: async () => [
          {
            id: "codex",
            displayName: "Codex",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: true,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: ["full"],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          models: [
            {
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              description: "test",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "test" },
              ],
              defaultReasoningEffort: "medium",
              isDefault: true,
            },
          ],
          selectedOnlyModels: [],
          modelLoadError: null,
        }),
      },
      plugins: {
        callRpc: async ({ input }) => {
          const { environmentId } = input as { environmentId: string };
          if (environmentId !== "environment-origin" && options.unavailableStatus) {
            if (options.unavailableStatus === "throw") throw new Error("Host offline");
            return { outcome: options.unavailableStatus } as never;
          }
          const workspace = workspaces.get(environmentId);
          if (workspace === undefined) {
            throw new Error(`Unknown environment ${environmentId}`);
          }
          return {
            outcome: "available",
            workspace: {
              workingTree: {
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                fileCount: workspace.uncommittedFiles.length,
                files: workspace.uncommittedFiles.map((path) => ({
                  path,
                  status: "M",
                  insertions: 1,
                  deletions: 0,
                })),
                hasUncommittedChanges: workspace.uncommittedFiles.length > 0,
                state:
                  workspace.uncommittedFiles.length > 0 ? "dirty_uncommitted" : "clean",
              },
              checkout: {
                kind: "branch",
                branchName: workspace.branchName,
                headSha: workspace.headSha ?? "abc123",
              },
              branch: {
                currentBranch: workspace.branchName,
                defaultBranch: "main",
              },
              mergeBase: {
                insertions: 0,
                deletions: 0,
                lineStatsComplete: true,
                fileCount: workspace.changedFiles,
                squashMergeCheckComplete: true,
                files: Array.from(
                  { length: workspace.changedFiles },
                  (_unused, index) => ({
                    path: `changed-${index}.ts`,
                    status: "M",
                    insertions: 1,
                    deletions: 0,
                  }),
                ),
                mergeBaseBranch: "main",
                baseRef: "abc000",
                aheadCount: workspace.changedFiles,
                behindCount: 0,
                hasCommittedUnmergedChanges: workspace.changedFiles > 0,
                commits: [],
              },
            },
          } as never;
        },
      },
      environments: {
        get: async ({ environmentId }) =>
          ({
            id: environmentId,
            projectId: "project-test",
            hostId: "host-1",
            path: "/workspace",
            branchName: workspaces.get(environmentId)?.branchName ?? null,
            baseBranch: "main",
          }) as never,
        commit: async ({ environmentId }) => {
          commits.push(environmentId);
          const workspace = workspaces.get(environmentId);
          if (workspace !== undefined) workspace.uncommittedFiles = [];
          return {
            ok: true,
            action: "commit",
            message: "committed",
            commitSha: "def456",
            commitSubject: "lane work",
          } as never;
        },
        archiveThreads: async ({ environmentId }) => {
          archivedEnvironments.push(environmentId);
          return { ok: true, archived: 1 } as never;
        },
        delete: async ({ environmentId }) => {
          deletedEnvironments.push(environmentId);
          return { ok: true } as never;
        },
      },
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db, DEFAULT_WORKFLOW_SETTINGS);

  return {
    bb,
    db,
    harness,
    service,
    commits,
    archivedEnvironments,
    deletedEnvironments,
    workspaces,
    childCount: () => childCount,
    async start(workflowSource: string, allowDirty = false) {
      return service.start({
        projectId: "project-test",
        originThreadId: "origin",
        source: workflowSource,
        args: null,
        resumedFromRunId: null,
        allowDirty,
      });
    },
    async runToCompletion(runId: string) {
      const controller = new AbortController();
      const worker = service.runWorker(controller.signal);
      try {
        await vi.waitFor(
          () => {
            const row = getRunRequired(db, runId);
            // Surface the run's own error instead of a bare timeout: a failed
            // run is the common outcome when a fake SDK method is missing.
            if (row.status === "failed") {
              throw new Error(`Workflow run failed: ${row.error}`);
            }
            expect(row.status).toBe("succeeded");
          },
          { timeout: 5_000, interval: 10 },
        );
      } finally {
        controller.abort();
        await worker;
      }
      return getRunRequired(db, runId);
    },
    spawnCalls() {
      return harness.sdk
        .callsTo("threads.spawn")
        .map(([input]) => input as Record<string, unknown>);
    },
    sendCalls() {
      return harness.sdk
        .callsTo("threads.send")
        .map(([input]) => input as Record<string, unknown>);
    },
  };
}

describe("workflow lane placement", () => {
  const harnesses: Array<ReturnType<typeof setup>["harness"]> = [];
  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("provisions a worktree on the origin host and branch, and parents it to the orchestrator", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        const lane = await agent("build it", {
          environment: { worktree: {} },
          reportIdentity: true,
        });
        const plain = await agent("just think");
        return { lane, plain };`),
    );
    await test.runToCompletion(run.id);

    const [laneSpawn, plainSpawn] = test.spawnCalls();
    expect(laneSpawn?.environment).toEqual({
      type: "host",
      hostId: "host-1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "abc123" },
      },
    });
    expect(laneSpawn?.parentThreadId).toBe("origin");

    // An ordinary worker stays a root thread: parenting every worker would
    // notify the orchestrator once per call in a hundred-call run.
    expect(plainSpawn?.environment).toEqual({
      type: "reuse",
      environmentId: "environment-origin",
    });
    expect(plainSpawn).not.toHaveProperty("parentThreadId");
  });

  it("freezes the launch commit before a moving branch advances", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source(`
      return await agent("build", { environment: { worktree: {} } });`));
    test.workspaces.get("environment-origin")!.headSha = "def456";
    test.workspaces.get("environment-origin")!.branchName = "other-branch";
    await test.runToCompletion(run.id);
    expect(test.service.get(run.id)?.launchBaseCommit).toBe("abc123");
    expect(test.spawnCalls()[0]?.environment).toMatchObject({
      workspace: { baseBranch: { kind: "named", name: "abc123" } },
    });
  });

  it("honors an explicit base branch over the origin branch", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        return await agent("build it", {
          environment: { worktree: { baseBranch: "release/2.0" } },
        });`),
    );
    await test.runToCompletion(run.id);
    expect(test.spawnCalls()[0]?.environment).toMatchObject({
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "release/2.0" },
      },
    });
  });

  it("lands a reviewer in the executor's worktree instead of a new one", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        const lane = await agent("build it", {
          environment: { worktree: {} },
          reportIdentity: true,
        });
        return await agent("review it", {
          environment: { environmentId: lane.environmentId },
        });`),
    );
    await test.runToCompletion(run.id);

    const spawns = test.spawnCalls();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.environment).toEqual({
      type: "reuse",
      environmentId: "environment-lane-1",
    });
  });

  it("reports the worker identity a script needs to address the lane again", async () => {
    const test = setup({
      workspaces: {
        "environment-lane-1": { changedFiles: 3, branchName: "bb/lane-1" },
      },
    });
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        return await agent("build it", {
          environment: { worktree: {} },
          reportIdentity: true,
        });`),
    );
    const finished = await test.runToCompletion(run.id);
    expect(JSON.parse(finished.resultJson!)).toEqual({
      value: "done",
      threadId: "child-1",
      environmentId: "environment-lane-1",
      branchName: "bb/lane-1",
      changedFiles: 3,
    });
  });

  it("continues an existing worker instead of spawning a second one", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        const lane = await agent("build it", {
          environment: { worktree: {} },
          reportIdentity: true,
        });
        const fixed = await agent("now fix the findings", {
          continue: lane.threadId,
        });
        return { lane, fixed };`),
    );
    await test.runToCompletion(run.id);

    expect(test.spawnCalls()).toHaveLength(1);
    expect(test.sendCalls()).toEqual([
      {
        threadId: "child-1",
        mode: "auto",
        input: [
          {
            type: "text",
            text: expect.stringContaining("now fix the findings") as unknown,
            mentions: [],
          },
        ],
      },
    ]);
    // Both calls are recorded against the same worker thread, so an idle
    // event has to resolve to the round that is actually running.
    expect(
      listCallsForRun(test.db, run.id).map((call) => call.childThreadId),
    ).toEqual(["child-1", "child-1"]);
  });

  it("refuses to continue a worker that runs on another provider", async () => {
    const test = setup({ workerProvider: { "child-1": "claude-code" } });
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        const lane = await agent("build it", {
          environment: { worktree: {} },
          reportIdentity: true,
        });
        try {
          await agent("fix it", { continue: lane.threadId });
          return "continued";
        } catch (error) {
          return String(error.message);
        }`),
    );
    const finished = await test.runToCompletion(run.id);
    expect(JSON.parse(finished.resultJson!)).toContain("it runs on claude-code");
  });

  it("commits what a lane worker left behind, because teardown would destroy it", async () => {
    const test = setup({
      workspaces: {
        "environment-lane-1": { uncommittedFiles: ["src/half-done.ts"] },
      },
    });
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        return await agent("build it", { environment: { worktree: {} } });`),
    );
    await test.runToCompletion(run.id);
    expect(test.commits).toEqual(["environment-lane-1"]);
  });

  it("leaves a clean lane workspace alone", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        return await agent("build it", { environment: { worktree: {} } });`),
    );
    await test.runToCompletion(run.id);
    expect(test.commits).toEqual([]);
  });
  it("never commits or tears down an explicitly reused dirty environment", async () => {
    const test = setup({
      workspaces: { foreign: { uncommittedFiles: ["someone-elses-work.ts"] } },
    });
    harnesses.push(test.harness);
    const run = await test.start(source(`
      return await agent("look only", {
        environment: { environmentId: "foreign" }, reportIdentity: true,
      });`));
    await test.runToCompletion(run.id);
    const report = await test.service.teardown(run.id, { discardUncommitted: true });
    expect(test.commits).toEqual([]);
    expect(report.destroyed).toEqual([]);
    expect(test.archivedEnvironments).toEqual([]);
    expect(test.deletedEnvironments).toEqual([]);
  });

  it.each([
    ["foreign worker", "stranger", {}],
    ["busy worker", "child-1", { status: "running" }],
    ["foreign project", "child-1", { projectId: "other-project" }],
    ["moved environment", "child-1", { environmentId: "foreign" }],
  ])("refuses continuation of a %s without sending", async (_label, threadId, state) => {
    const test = setup({ workerState: { [String(threadId)]: state as never } });
    harnesses.push(test.harness);
    const run = await test.start(source(`
      await agent("build", { environment: { worktree: {} }, reportIdentity: true });
      try {
        await agent("fix", { continue: ${JSON.stringify(threadId)} });
        return "unsafe";
      } catch (error) { return error.message; }`));
    const finished = await test.runToCompletion(run.id);
    expect(JSON.parse(finished.resultJson!)).toContain("Cannot continue worker");
    expect(test.sendCalls()).toEqual([]);
  });

  it("never retries an ambiguously acknowledged continuation send", async () => {
    const test = setup({ sendError: "provider temporarily unavailable" });
    harnesses.push(test.harness);
    const run = await test.start(source(`
      const lane = await agent("build", { environment: { worktree: {} }, reportIdentity: true });
      try { await agent("fix", { continue: lane.threadId }); }
      catch (error) { return error.message; }`));
    await test.runToCompletion(run.id);
    expect(test.sendCalls()).toHaveLength(1);
  });

  it("does not auto-commit a continued worker's dirty environment", async () => {
    const test = setup({ continuationUncommitted: ["uncommitted-fix.ts"] });
    harnesses.push(test.harness);
    const run = await test.start(source(`
      const lane = await agent("build", { environment: { worktree: {} }, reportIdentity: true });
      return await agent("fix", { continue: lane.threadId });`));
    await test.runToCompletion(run.id);
    expect(test.commits).toEqual([]);
    expect(test.workspaces.get("environment-lane-1")?.uncommittedFiles).toEqual(["uncommitted-fix.ts"]);
    const report = await test.service.teardown(run.id, { discardUncommitted: false });
    expect(report.destroyed).toEqual([]);
    expect(report.kept).toHaveLength(1);
  });

  it("refuses overlapping continuations of the same worker", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source(`
      const lane = await agent("build", { environment: { worktree: {} }, reportIdentity: true });
      return await Promise.all([1, 2].map(async n => {
        try { return await agent("fix " + n, { continue: lane.threadId }); }
        catch (error) { return error.message; }
      }));`));
    const finished = await test.runToCompletion(run.id);
    expect(JSON.parse(finished.resultJson!)).toEqual(expect.arrayContaining([
      expect.stringContaining("another call is using it"),
    ]));
    expect(test.sendCalls()).toHaveLength(1);
  });

});

describe("workflow origin preflight", () => {
  const harnesses: Array<ReturnType<typeof setup>["harness"]> = [];
  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("refuses to start over an uncommitted origin workspace", async () => {
    const test = setup({ originUncommitted: ["src/app.ts", "README.md"] });
    harnesses.push(test.harness);
    await expect(test.start(source(`return 1;`))).rejects.toThrow(
      "2 uncommitted file(s) (src/app.ts, README.md)",
    );
  });

  it("starts anyway when the caller accepts excluding that work", async () => {
    const test = setup({ originUncommitted: ["src/app.ts"] });
    harnesses.push(test.harness);
    await expect(
      test.start(source(`return 1;`), true),
    ).resolves.toMatchObject({ status: "queued" });
  });
});

describe("workflow lane teardown", () => {
  const harnesses: Array<ReturnType<typeof setup>["harness"]> = [];
  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("destroys a finished run's lane worktrees but never the origin environment", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        await agent("lane work", { environment: { worktree: {} } });
        return await agent("plain work");`),
    );
    await test.runToCompletion(run.id);

    const report = await test.service.teardown(run.id, {
      discardUncommitted: false,
    });
    expect(report.destroyed).toEqual([
      { environmentId: "environment-lane-1", branchName: "bb/lane-1" },
    ]);
    expect(report.kept).toEqual([]);
    expect(test.archivedEnvironments).toEqual(["environment-lane-1"]);
    expect(test.deletedEnvironments).toEqual(["environment-lane-1"]);
  });

  it("keeps a dirty lane worktree rather than force-removing uncommitted work", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        return await agent("lane work", { environment: { worktree: {} } });`),
    );
    await test.runToCompletion(run.id);
    // Something wrote to the lane after its call settled.
    test.workspaces.get("environment-lane-1")!.uncommittedFiles = [
      "src/late.ts",
    ];

    const report = await test.service.teardown(run.id, {
      discardUncommitted: false,
    });
    expect(report.destroyed).toEqual([]);
    expect(report.kept).toEqual([
      {
        environmentId: "environment-lane-1",
        branchName: "bb/lane-1",
        reason: "1 uncommitted file(s) would be discarded",
      },
    ]);
    expect(test.deletedEnvironments).toEqual([]);

    const forced = await test.service.teardown(run.id, {
      discardUncommitted: true,
    });
    expect(forced.destroyed).toHaveLength(1);
    expect(test.deletedEnvironments).toEqual(["environment-lane-1"]);
  });

  it.each(["unavailable", "not_applicable", "unknown", "throw"] as const)(
    "preserves a lane with %s status even when discard is requested",
    async (unavailableStatus) => {
      const test = setup({ unavailableStatus });
      harnesses.push(test.harness);
      const run = await test.start(source(`
        return await agent("lane", { environment: { worktree: {} } });`));
      await test.runToCompletion(run.id);
      const report = await test.service.teardown(run.id, { discardUncommitted: true });
      expect(report.kept).toHaveLength(1);
      expect(report.destroyed).toEqual([]);
      expect(test.archivedEnvironments).toEqual([]);
      expect(test.deletedEnvironments).toEqual([]);
      expect(test.commits).toEqual([]);
    },
  );

  it("refuses to tear down a run that is still going", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source(`return 1;`));
    await expect(
      test.service.teardown(run.id, { discardUncommitted: false }),
    ).rejects.toThrow("stop it before tearing down");
  });
});
