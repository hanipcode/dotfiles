import { testRender } from "@opentui/react/test-utils"
import { describe, expect, it } from "bun:test"
import type { ActionPlan, GlobalView } from "../src/application/model.ts"
import { CommandRecord, RepoState } from "../src/domain.ts"
import { GlobalDashboard, sourceCursorForInspection } from "../src/ui/GlobalDashboard.tsx"

const state = RepoState.make({
  version: 2,
  repoId: "operator",
  repoRoot: "/repos/operator",
  commonDir: "/repos/operator/.git",
  runnerPath: "/home/user/.runbox/data/operator/worktree",
  environmentSourceRoot: "/repos/operator",
  source: {
    kind: "worktree",
    worktreePath: "/repos/operator",
    branch: "fix/dropdown",
    commit: "1234567890abcdef",
    stack: null,
  },
  preparedCommits: ["1234567890abcdef"],
  preparedCommands: ["1234567890abcdef:apps/operator:dev"],
  commands: {},
})

const view: GlobalView = {
  generatedAt: Date.now(),
  repositories: [{
    repoId: "operator",
    name: "operator",
    key: "operator#operator",
    repositoryRoot: "/repos/operator",
    storage: "current",
    runnerPath: state.runnerPath,
    environmentSourceRoot: state.environmentSourceRoot,
    activeSource: state.source,
    daemon: "online",
    commandCount: 0,
    activeCommandCount: 0,
    stateRevision: "revision",
    problem: null,
  }],
  selected: {
    state,
    worktrees: [{
      path: "/repos/operator",
      branch: "fix/dropdown",
      head: "1234567890abcdef",
      locked: null,
      prunable: null,
      isActiveSource: true,
      isEnvironmentSource: true,
    }],
    selectedWorktreePath: "/repos/operator",
    packages: [{
      path: "apps/operator",
      name: "operator-app",
      manager: "bun",
      scripts: [{ name: "dev", command: "vite", prepared: true, tracked: null }],
    }],
    selectedCommand: null,
    selectedLog: "",
    selectedMetrics: null,
    preparation: {
      setup: "ready",
      preparedCommandCount: 1,
      activeInstructionCount: 1,
      lastPhase: "succeeded",
      lastAt: Date.now(),
      problem: null,
    },
    problems: [],
  },
}

describe("GlobalDashboard", () => {
  it("preserves a highlighted source during passive inspection", () => {
    const worktrees = [{ path: "/repos/feature" }, { path: "/repos/main" }]
    expect(sourceCursorForInspection(0, worktrees, "/repos/main", true)).toBe(0)
    expect(sourceCursorForInspection(0, worktrees, "/repos/main", false)).toBe(1)
  })

  it("renders repository, source, and package command panes", async () => {
    const pending = new Promise<GlobalView>(() => {})
    const setup = await testRender(
      <GlobalDashboard
        initial={view}
        onInspect={() => pending}
        onPlan={() => new Promise(() => {})}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 140, height: 28, useMouse: true },
    )
    try {
      await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("runbox  GLOBAL   1 repositories   0 active")
      expect(frame).toContain("runbox  GLOBAL")
      expect(frame).toContain("repositories")
      expect(frame).toContain("execution sources")
      expect(frame).toContain("fix/dropdown")
      expect(frame).toContain("apps/operator:dev")
      expect(frame).toContain("[ready]")
      expect(frame).not.toContain("available")
      expect(frame).toContain("detail / retained output")

      setup.resize(72, 20)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("repositories")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("reviews a run plan before executing it", async () => {
    let executions = 0
    const plan: ActionPlan = {
      id: "plan",
      stateRevision: "revision",
      intent: {
        type: "run",
        repoId: "operator",
        worktreePath: "/repos/operator",
        expectedHead: "1234567890abcdef",
        packagePath: "apps/operator",
        script: "dev",
        args: [],
      },
      title: "Run apps/operator:dev",
      effects: ["Start apps/operator:dev"],
      requiresConfirmation: true,
      dirtySummary: null,
      dirtyFingerprint: null,
    }
    const setup = await testRender(
      <GlobalDashboard
        initial={view}
        onInspect={() => Promise.resolve(view)}
        onPlan={() => Promise.resolve(plan)}
        onCommit={() => Promise.resolve(plan)}
        onExecute={() => {
          executions += 1
          return Promise.resolve({ message: "started", view })
        }}
      />,
      { width: 140, height: 28, useMouse: true },
    )
    try {
      await setup.flush()
      setup.mockInput.pressKey("r")
      await Bun.sleep(10)
      await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Run apps/operator:dev")
      expect(frame).toContain("Planned effects")
      expect(frame).toContain("enter confirm")
      expect(executions).toBe(0)

      setup.mockInput.pressEnter()
      await Bun.sleep(10)
      await setup.flush()
      expect(executions).toBe(1)
      expect(setup.captureCharFrame()).toContain("started")

      await Bun.sleep(1_600)
      await setup.flush()
      const settled = setup.captureCharFrame()
      expect(settled).not.toContain("started")
      expect(settled).toContain("tab pane")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("maps shifted r to restart instead of run", async () => {
    const running = CommandRecord.make({
      id: "apps/operator:dev",
      packagePath: "apps/operator",
      script: "dev",
      args: [],
      status: "running",
      pid: 42,
      startedAt: Date.now(),
      exitCode: null,
      message: null,
      logFile: "/logs/dev.log",
      processToken: "token",
    })
    const runningState = RepoState.make({ ...state, commands: { [running.id]: running } })
    const runningView: GlobalView = {
      ...view,
      selected: view.selected === null ? null : {
        ...view.selected,
        state: runningState,
        packages: view.selected.packages.map((pkg) => ({
          ...pkg,
          scripts: pkg.scripts.map((script) => ({ ...script, tracked: running })),
        })),
      },
    }
    const observed: { intentType: string | null } = { intentType: null }
    const setup = await testRender(
      <GlobalDashboard
        initial={runningView}
        onInspect={() => Promise.resolve(runningView)}
        onPlan={(intent) => {
          observed.intentType = intent.type
          return Promise.resolve({
            id: "restart-plan",
            stateRevision: "revision",
            intent,
            title: "Restart command",
            effects: ["Restart apps/operator:dev"],
            requiresConfirmation: true,
            dirtySummary: null,
            dirtyFingerprint: null,
          })
        }}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 120, height: 26, useMouse: true },
    )
    try {
      await setup.flush()
      setup.mockInput.pressKey("r", { shift: true })
      await Bun.sleep(10)
      await setup.flush()
      expect(observed.intentType).toBe("restart")
    } finally {
      setup.renderer.destroy()
    }
  })

})
