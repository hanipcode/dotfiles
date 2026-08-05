import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { describe, expect, it } from "bun:test"
import { CommandRecord, RepoSnapshot, RepoState, type ProcessMetrics } from "../src/domain.ts"
import { Dashboard } from "../src/ui/Dashboard.tsx"

const state = (commands: Readonly<Record<string, CommandRecord>>) => RepoState.make({
  version: 2,
  repoId: "repo",
  repoRoot: "/repo",
  commonDir: "/repo/.git",
  runnerPath: "/runner",
  source: {
    kind: "worktree",
    worktreePath: "/repo",
    branch: "main",
    commit: "1234567890abcdef",
    stack: null,
  },
  preparedCommits: [],
  preparedCommands: [],
  commands,
})

const snapshot = (
  commands: Readonly<Record<string, CommandRecord>> = {},
  logs: Readonly<Record<string, string>> = {},
  metrics: Readonly<Record<string, ProcessMetrics>> = {},
) => RepoSnapshot.make({
  state: state(commands),
  scripts: ["dev"],
  packagePath: "",
  logs,
  metrics,
})

const running = CommandRecord.make({
  id: ".:dev",
  packagePath: "",
  script: "dev",
  args: [],
  status: "running",
  pid: 4242,
  startedAt: Date.now() - 10_000,
  exitCode: null,
  message: null,
  logFile: "/logs/dev.log",
  processToken: "token",
})

describe("Dashboard", () => {
  it("renders the tracker before an initial launch resolves", async () => {
    const pending = new Promise<RepoSnapshot>(() => {})
    const setup = await testRender(
      <Dashboard
        initial={snapshot()}
        selectedCommand=".:dev"
        initialLaunch={{ id: ".:dev", script: "dev", execute: () => pending }}
        onRefresh={() => pending}
        onStart={() => pending}
        onStop={() => pending}
      />,
      { width: 90, height: 24, useMouse: true },
    )
    try {
      await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("command: dev")
      expect(frame).toContain("preparing")
      expect(frame).toContain("requesting launch")
      expect(frame).toContain("CPU")
      expect(frame).toContain("RAM")
      expect(frame).toContain("retained output")

      setup.resize(50, 15)
      await setup.flush()
      const narrow = setup.captureCharFrame()
      expect(narrow).toContain("command: dev")
      expect(narrow).toContain("process metrics")
      expect(narrow).toContain("retained output")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders available commands without repetitive status labels", async () => {
    const pending = new Promise<RepoSnapshot>(() => {})
    const setup = await testRender(
      <Dashboard
        initial={snapshot()}
        onRefresh={() => pending}
        onStart={() => pending}
        onStop={() => pending}
      />,
      { width: 50, height: 15, useMouse: true },
    )
    try {
      await setup.flush()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("> dev")
      expect(frame).not.toContain("available")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("scrolls retained output with the keyboard and mouse", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${String(index).padStart(2, "0")}`).join("\n")
    const current = snapshot(
      { ".:dev": running },
      { ".:dev": lines },
      { ".:dev": { pid: 4242, processCount: 3, cpuPercent: 37.2, memoryBytes: 812 * 1024 * 1024, uptimeSeconds: 10 } },
    )
    const setup = await testRender(
      <Dashboard
        initial={current}
        selectedCommand=".:dev"
        onRefresh={() => new Promise<RepoSnapshot>(() => {})}
        onStart={() => Promise.resolve(current)}
        onStop={() => Promise.resolve(current)}
      />,
      { width: 90, height: 24, useMouse: true },
    )
    try {
      await setup.flush()
      const scroll = setup.renderer.root.findDescendantById("dashboard-logs") as ScrollBoxRenderable
      expect(scroll).toBeDefined()
      expect(scroll.scrollTop).toBeGreaterThan(0)
      const bottom = scroll.scrollTop

      setup.mockInput.pressArrow("up")
      await setup.flush()
      expect(scroll.scrollTop).toBeLessThan(bottom)

      setup.mockInput.pressKey("HOME")
      await setup.flush()
      expect(scroll.scrollTop).toBe(0)

      setup.mockInput.pressKey("END")
      await setup.flush()
      expect(scroll.scrollTop).toBeGreaterThan(0)
      const restoredBottom = scroll.scrollTop

      await setup.mockMouse.scroll(5, 16, "up")
      await setup.flush()
      expect(scroll.scrollTop).toBeLessThan(restoredBottom)
    } finally {
      setup.renderer.destroy()
    }
  })
})
