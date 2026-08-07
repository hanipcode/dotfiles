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

  it("preserves highlighted rows when passive inspection refreshes", async () => {
    const refreshView: GlobalView = {
      ...view,
      repositories: [
        ...view.repositories,
        {
          ...view.repositories[0]!,
          repoId: "worker",
          name: "worker",
          key: "worker#worker",
          repositoryRoot: "/repos/worker",
        },
      ],
      selected: view.selected === null ? null : {
        ...view.selected,
        worktrees: [
          ...view.selected.worktrees,
          {
            path: "/repos/operator-feature",
            branch: "feature/next",
            head: "abcdef1234567890",
            locked: null,
            prunable: null,
            isActiveSource: false,
            isEnvironmentSource: false,
          },
        ],
        packages: view.selected.packages.map((pkg) => ({
          ...pkg,
          scripts: [
            ...pkg.scripts,
            { name: "preview", command: "vite preview", prepared: true, tracked: null },
          ],
        })),
      },
    }
    const setup = await testRender(
      <GlobalDashboard
        initial={refreshView}
        onInspect={() => Promise.resolve(refreshView)}
        onPlan={() => new Promise(() => {})}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 140, height: 28, useMouse: true },
    )
    try {
      await setup.flush()
      setup.mockInput.pressArrow("down")
      await Bun.sleep(10)
      setup.mockInput.pressKey("w")
      await Bun.sleep(10)
      setup.mockInput.pressArrow("down")
      await Bun.sleep(10)
      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
      setup.mockInput.pressArrow("down")
      await Bun.sleep(2_100)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain("> - worker")
      expect(frame).toContain("> feature/next")
      expect(frame).toContain("> apps/operator:preview")
    } finally {
      setup.renderer.destroy()
    }
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
      expect(frame).not.toContain("runbox  GLOBAL")
      expect(frame).toContain("operator#operator  fix/dropdown@12345678")
      expect(frame).toContain("repositories")
      expect(frame).toContain("sources")
      expect(frame).toContain("p repositories (1)")
      expect(frame).toContain("w sources (1)")
      expect(frame).toContain("c commands (1)")
      expect(frame).toContain("o logs")
      expect(frame).not.toContain("repositories1")
      expect(frame).not.toContain("commands1")
      expect(frame).toContain("fix/dropdown")
      expect(frame).toContain("apps/operator:dev")
      expect(frame).toContain("[ready]")
      expect(frame).not.toContain("available")
      const lines = frame.split("\n")
      expect(lines[1]?.startsWith(" ╭")).toBe(true)
      expect(lines[1]).toContain("p repositories (1)")
      expect(lines[1]).toContain("w sources (1)")
      expect(lines[1]).toContain("c commands (1)")
      expect(lines[2]).not.toContain("p repositories (1)")
      const logsHeader = lines.findIndex((line) => line.includes("o logs"))
      expect(logsHeader).toBeGreaterThan(1)
      expect(lines[logsHeader]?.startsWith(" ╭")).toBe(true)
      expect(lines[logsHeader]?.trimEnd().endsWith("╮")).toBe(true)
      const richFrame = setup.captureSpans()
      const repositoryHeader = richFrame.lines.find((line) => line.spans.some((span) => span.text.includes("repositories (1)")))
      const shortcutSpan = repositoryHeader?.spans.find((span) => span.text === "p")
      const labelSpan = repositoryHeader?.spans.find((span) => span.text.includes("repositories (1)"))
      expect(shortcutSpan).toBeDefined()
      expect(labelSpan).toBeDefined()
      expect(shortcutSpan?.fg.equals(labelSpan?.fg)).toBe(false)

      setup.resize(72, 20)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("repositories")
      setup.resize(140, 28)
      await setup.flush()
      const restored = setup.captureCharFrame()
      expect(restored).toContain("p repositories (1)")
      expect(restored.split("\n")[1]?.startsWith(" ╭")).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps logs isolated in a short terminal", async () => {
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
    const runningView: GlobalView = {
      ...view,
      selected: view.selected === null ? null : {
        ...view.selected,
        state: RepoState.make({ ...state, commands: { [running.id]: running } }),
        selectedCommand: running,
        selectedLog: "ready",
        packages: view.selected.packages.map((pkg) => ({
          ...pkg,
          scripts: pkg.scripts.map((script) => ({ ...script, tracked: running })),
        })),
      },
    }
    const setup = await testRender(
      <GlobalDashboard
        initial={runningView}
        onInspect={() => new Promise(() => {})}
        onPlan={() => new Promise(() => {})}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 140, height: 8, useMouse: true },
    )
    try {
      await setup.flush()
      setup.mockInput.pressKey("o")
      await Bun.sleep(10)
      await setup.flush()
      setup.resize(140, 28)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("o logs")
      setup.resize(140, 8)
      await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("o logs")
      expect(frame).toContain("ready")
      expect(frame).not.toContain("status  apps/operator:dev")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("reviews a run plan before executing it", async () => {
    let executions = 0
    let plans = 0
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
        onPlan={() => {
          plans += 1
          return Promise.resolve(plan)
        }}
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
      expect(plans).toBe(0)

      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
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
      expect(settled).toContain("p repos")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps dirty-worktree controls separate from changed files", async () => {
    const dirtyPlan: ActionPlan = {
      id: "dirty-plan",
      stateRevision: "revision",
      intent: {
        type: "run",
        repoId: "operator",
        worktreePath: "/repos/operator",
        expectedHead: "1234567890abcdef",
        packagePath: "",
        script: "dev",
        args: [],
      },
      title: "Run .:dev",
      effects: [
        "Migrate legacy storage to ~/.runbox when the daemon is idle",
        "Commit source worktree changes before switching",
        "Switch runner a5549902 -> f4514c8d",
        "Start .:dev",
      ],
      requiresConfirmation: true,
      dirtySummary: [
        " M packages/app/src/review/review-detail-view.tsx",
        " M packages/app/src/test/app-browser-support.tsx",
        " M packages/app/src/review/review-list.tsx",
      ].join("\n"),
      dirtyFingerprint: "dirty",
    }
    const setup = await testRender(
      <GlobalDashboard
        initial={view}
        onInspect={() => Promise.resolve(view)}
        onPlan={() => Promise.resolve(dirtyPlan)}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 92, height: 24, useMouse: true },
    )
    try {
      await setup.flush()
      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
      await setup.flush()
      setup.mockInput.pressKey("r")
      await Bun.sleep(10)
      await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("M packages/app/src/review/review-list.tsx")
      expect(frame).toContain("c manual message  a Luna message  esc cancel")
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
      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
      await setup.flush()
      setup.mockInput.pressKey("r", { shift: true })
      await Bun.sleep(10)
      await setup.flush()
      expect(observed.intentType).toBe("restart")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("focuses panes directly with p, w, c, and o", async () => {
    const setup = await testRender(
      <GlobalDashboard
        initial={view}
        onInspect={() => Promise.resolve(view)}
        onPlan={() => new Promise(() => {})}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 72, height: 20, useMouse: true },
    )
    try {
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("p repositories (1)")

      setup.mockInput.pressKey("w")
      await Bun.sleep(10)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("w sources (1)")

      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("c commands (1)")

      setup.mockInput.pressKey("o")
      await Bun.sleep(10)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("o logs")

      setup.mockInput.pressKey("p")
      await Bun.sleep(10)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("p repositories (1)")

      setup.mockInput.pressKey("\t", { shift: true })
      await Bun.sleep(10)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("o logs")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("scrolls long command lists to keep the highlighted row visible", async () => {
    const longCommandView: GlobalView = {
      ...view,
      selected: view.selected === null ? null : {
        ...view.selected,
        packages: view.selected.packages.map((pkg) => ({
          ...pkg,
          scripts: Array.from({ length: 16 }, (_, index) => ({
            name: `script-${index}`,
            command: `run script-${index}`,
            prepared: true,
            tracked: null,
          })),
        })),
      },
    }
    const setup = await testRender(
      <GlobalDashboard
        initial={longCommandView}
        onInspect={() => Promise.resolve(longCommandView)}
        onPlan={() => new Promise(() => {})}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 140, height: 28, useMouse: true },
    )
    try {
      await setup.flush()
      expect(setup.captureCharFrame()).toMatch(/[▀▄█]/)
      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
      for (let index = 0; index < 12; index += 1) {
        setup.mockInput.pressArrow("down")
        await Bun.sleep(5)
      }
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("> apps/operator:script-12")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("switches the highlighted source rather than the previously inspected source", async () => {
    const secondPath = "/repos/operator-feature"
    const multiSourceView: GlobalView = {
      ...view,
      selected: view.selected === null ? null : {
        ...view.selected,
        worktrees: [
          ...view.selected.worktrees,
          {
            path: secondPath,
            branch: "feature/next",
            head: "abcdef1234567890",
            locked: null,
            prunable: null,
            isActiveSource: false,
            isEnvironmentSource: false,
          },
        ],
      },
    }
    const inspectedSecond: GlobalView = {
      ...multiSourceView,
      selected: multiSourceView.selected === null ? null : {
        ...multiSourceView.selected,
        selectedWorktreePath: secondPath,
      },
    }
    const observed: { worktreePath: string | null } = { worktreePath: null }
    const setup = await testRender(
      <GlobalDashboard
        initial={multiSourceView}
        onInspect={(query) => Promise.resolve(query?.worktreePath === secondPath ? inspectedSecond : multiSourceView)}
        onPlan={(intent) => {
          observed.worktreePath = intent.type === "switch" ? intent.worktreePath : null
          return Promise.resolve({
            id: "switch-plan",
            stateRevision: "revision",
            intent,
            title: "Switch managed runner",
            effects: ["Switch runner"],
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
      setup.mockInput.pressKey("w")
      await Bun.sleep(10)
      await setup.flush()
      setup.mockInput.pressKey("f")
      await Bun.sleep(10)
      await setup.flush()
      await setup.mockInput.typeText("feature")
      setup.mockInput.pressEscape()
      await Bun.sleep(100)
      await setup.flush()
      setup.mockInput.pressKey("x")
      await Bun.sleep(10)
      await setup.flush()
      expect(observed.worktreePath).toBe(secondPath)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps pane filters after escape and clears an empty filter", async () => {
    const otherRepository = {
      ...view.repositories[0]!,
      repoId: "worker",
      name: "worker",
      key: "worker#worker",
      repositoryRoot: "/repos/worker",
    }
    const multiRepositoryView: GlobalView = {
      ...view,
      repositories: [...view.repositories, otherRepository],
    }
    const setup = await testRender(
      <GlobalDashboard
        initial={multiRepositoryView}
        onInspect={() => Promise.resolve(multiRepositoryView)}
        onPlan={() => new Promise(() => {})}
        onCommit={() => new Promise(() => {})}
        onExecute={() => new Promise(() => {})}
      />,
      { width: 140, height: 26, useMouse: true },
    )
    try {
      await setup.flush()
      setup.mockInput.pressKey("f")
      await Bun.sleep(10)
      await setup.flush()
      await setup.mockInput.typeText("worker")
      await setup.flush()
      let frame = setup.captureCharFrame()
      expect(frame).toContain("filtering: worker")
      expect(frame).toContain("> - worker")
      expect(frame).not.toContain("> - operator")

      setup.mockInput.pressEscape()
      await Bun.sleep(100)
      await setup.flush()
      frame = setup.captureCharFrame()
      expect(frame).toContain("p repositories (filtered)")

      setup.mockInput.pressKey("f")
      await Bun.sleep(10)
      await setup.flush()
      for (let index = 0; index < "worker".length; index += 1) setup.mockInput.pressBackspace()
      setup.mockInput.pressEscape()
      await Bun.sleep(100)
      await setup.flush()
      frame = setup.captureCharFrame()
      expect(frame).toContain("p repositories (2)")
      expect(frame).not.toContain("(filtered)")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("runs the command selected by a local filter", async () => {
    const commandView: GlobalView = {
      ...view,
      selected: view.selected === null ? null : {
        ...view.selected,
        packages: view.selected.packages.map((pkg) => ({
          ...pkg,
          scripts: [
            ...pkg.scripts,
            { name: "preview", command: "vite preview", prepared: true, tracked: null },
          ],
        })),
      },
    }
    const observed: { script: string | null } = { script: null }
    const setup = await testRender(
      <GlobalDashboard
        initial={commandView}
        onInspect={() => Promise.resolve(commandView)}
        onPlan={(intent) => {
          observed.script = intent.type === "run" ? intent.script : null
          return Promise.resolve({
            id: "run-plan",
            stateRevision: "revision",
            intent,
            title: "Run command",
            effects: ["Run command"],
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
      setup.mockInput.pressKey("c")
      await Bun.sleep(10)
      await setup.flush()
      setup.mockInput.pressKey("f")
      await Bun.sleep(10)
      await setup.flush()
      await setup.mockInput.typeText("preview")
      setup.mockInput.pressEscape()
      await Bun.sleep(100)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("c commands (filtered)")
      setup.mockInput.pressKey("r")
      await Bun.sleep(10)
      await setup.flush()
      expect(observed.script).toBe("preview")
    } finally {
      setup.renderer.destroy()
    }
  })

})
