import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CommandRecord, ProcessMetrics, RepoSnapshot } from "../domain.ts"
import { commandId } from "../domain.ts"
import { formatLogOutput } from "../logFormat.ts"
import { CommandListRow, commandStatusColor } from "./CommandListRow.tsx"
import { theme } from "./theme.ts"
import { useExit } from "./runApp.tsx"

interface InitialLaunch {
  readonly id: string
  readonly script: string
  readonly execute: () => Promise<RepoSnapshot>
}

interface DashboardProps {
  readonly initial: RepoSnapshot
  readonly selectedCommand?: string
  readonly initialLaunch?: InitialLaunch
  readonly onRefresh: () => Promise<RepoSnapshot>
  readonly onStart: (script: string) => Promise<RepoSnapshot>
  readonly onStop: (record: CommandRecord) => Promise<RepoSnapshot>
}

interface MetricHistory {
  readonly cpu: ReadonlyArray<number>
  readonly memory: ReadonlyArray<number>
}

type Row =
  | { readonly type: "command"; readonly key: string; readonly record: CommandRecord }
  | { readonly type: "script"; readonly key: string; readonly script: string }

const activeStatuses = new Set(["preparing", "starting", "running", "stopping"])
const spinnerStatuses = new Set(["preparing", "starting", "stopping"])
const spinnerFrames = ["|", "/", "-", "\\"] as const
const graphLevels = " .:-=+*#%@"

const bytes = (value: number): string => {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}K`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}M`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)}G`
}

const duration = (seconds: number): string => {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`
}

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")

const appendMetrics = (
  current: Readonly<Record<string, MetricHistory>>,
  metrics: Readonly<Record<string, ProcessMetrics>>,
): Readonly<Record<string, MetricHistory>> => {
  const next = { ...current }
  for (const [id, sample] of Object.entries(metrics)) {
    const history = next[id] ?? { cpu: [], memory: [] }
    next[id] = {
      cpu: [...history.cpu, sample.cpuPercent].slice(-60),
      memory: [...history.memory, sample.memoryBytes].slice(-60),
    }
  }
  return next
}

const graph = (samples: ReadonlyArray<number>, width: number, floor: number): string => {
  const visible = samples.slice(-width)
  const ceiling = Math.max(floor, ...visible, 1)
  const rendered = visible.map((sample) => {
    const index = Math.min(graphLevels.length - 1, Math.round(sample / ceiling * (graphLevels.length - 1)))
    return graphLevels[index] ?? " "
  }).join("")
  return rendered.padStart(width)
}

export const Dashboard = ({
  initial,
  selectedCommand,
  initialLaunch,
  onRefresh,
  onStart,
  onStop,
}: DashboardProps) => {
  const exit = useExit()
  const terminal = useTerminalDimensions()
  const [snapshot, setSnapshot] = useState(initial)
  const [histories, setHistories] = useState<Readonly<Record<string, MetricHistory>>>(() =>
    appendMetrics({}, initial.metrics)
  )
  const [cursor, setCursor] = useState(0)
  const [detail, setDetail] = useState<string | null>(selectedCommand ?? null)
  const [pendingLaunch, setPendingLaunch] = useState<Pick<InitialLaunch, "id" | "script"> | null>(
    initialLaunch ?? null,
  )
  const [message, setMessage] = useState<string | null>(null)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const launched = useRef(false)
  const logScroll = useRef<ScrollBoxRenderable>(null)

  const applySnapshot = useCallback((next: RepoSnapshot) => {
    setSnapshot(next)
    setHistories((current) => appendMetrics(current, next.metrics))
  }, [])

  const rows = useMemo<ReadonlyArray<Row>>(() => {
    const records = Object.values(snapshot.state.commands)
    const commands = records.map((record): Row => ({ type: "command", key: record.id, record }))
    const activeIds = new Set(
      records.filter((record) => activeStatuses.has(record.status)).map((record) => record.id),
    )
    const scripts = snapshot.scripts
      .filter((script) => !activeIds.has(commandId(snapshot.packagePath, script)))
      .map((script): Row => ({ type: "script", key: `script:${script}`, script }))
    return [...commands, ...scripts]
  }, [snapshot])

  useEffect(() => {
    if (initialLaunch === undefined || launched.current) return
    launched.current = true
    void initialLaunch.execute().then((next) => {
      applySnapshot(next)
      setPendingLaunch(null)
    }).catch((cause) => {
      setPendingLaunch(null)
      setMessage(String(cause))
    })
  }, [applySnapshot, initialLaunch])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await onRefresh()
        if (!cancelled) applySnapshot(next)
      } catch (cause) {
        if (!cancelled) setMessage(String(cause))
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1_000)
      }
    }
    timer = setTimeout(poll, 1_000)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [applySnapshot, onRefresh])

  const persistedDetail = detail === null ? undefined : snapshot.state.commands[detail]
  const syntheticDetail: CommandRecord | undefined = detail !== null && pendingLaunch?.id === detail
    ? {
        id: pendingLaunch.id,
        packagePath: snapshot.packagePath,
        script: pendingLaunch.script,
        args: [],
        status: "preparing",
        pid: null,
        startedAt: null,
        exitCode: null,
        message: "requesting launch",
        logFile: "",
        processToken: null,
      }
    : undefined
  const detailRecord = syntheticDetail ?? persistedDetail
  const spinning = detailRecord !== undefined && spinnerStatuses.has(detailRecord.status)

  useEffect(() => {
    if (!spinning) return
    const timer = setInterval(() => setSpinnerFrame((current) => (current + 1) % spinnerFrames.length), 100)
    return () => clearInterval(timer)
  }, [spinning])

  const selected = rows[Math.min(cursor, Math.max(rows.length - 1, 0))]
  const move = useCallback((delta: number) => {
    setCursor((current) => Math.max(0, Math.min(rows.length - 1, current + delta)))
  }, [rows.length])

  const launch = useCallback((script: string) => {
    const id = commandId(snapshot.packagePath, script)
    setPendingLaunch({ id, script })
    setDetail(id)
    setMessage(null)
    void onStart(script).then((next) => {
      applySnapshot(next)
      setPendingLaunch(null)
    }).catch((cause) => {
      setPendingLaunch(null)
      setMessage(String(cause))
    })
  }, [applySnapshot, onStart, snapshot.packagePath])

  useKeyboard(useCallback((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      exit()
      return
    }
    if (detail !== null) {
      if (key.name === "escape") setDetail(null)
      if (key.name === "s" && detailRecord !== undefined && detailRecord.processToken !== null) {
        void onStop(detailRecord).then((next) => {
          applySnapshot(next)
          setPendingLaunch(null)
          setDetail(null)
        }).catch((cause) => setMessage(String(cause)))
      }
      return
    }
    if (key.name === "j" || key.name === "down") move(1)
    if (key.name === "k" || key.name === "up") move(-1)
    if (key.name === "return" && selected !== undefined) {
      if (selected.type === "command") setDetail(selected.record.id)
      else launch(selected.script)
    }
  }, [applySnapshot, detail, detailRecord, exit, launch, move, onStop, selected]))

  const source = snapshot.state.source
  const sourceLabel = source?.stack === null || source?.stack === undefined
    ? `${source?.branch ?? "detached"}@${source?.commit.slice(0, 8) ?? "not-prepared"}`
    : `${source.stack.trunk} > ${source.stack.branches.map((branch) => branch.name).join(" > ")} [${source.stack.topBranch}]`

  if (detailRecord !== undefined) {
    const compact = terminal.height < 18
    const narrow = terminal.width < 72
    const metrics = snapshot.metrics[detailRecord.id]
    const history = histories[detailRecord.id] ?? { cpu: [], memory: [] }
    const graphWidth = Math.max(8, Math.min(narrow ? terminal.width - 22 : 48, 48))
    const rawOutput = detailRecord.status === "preparing" && detailRecord.message?.includes("repository")
      ? snapshot.logs.setup ?? snapshot.logs[detailRecord.id] ?? ""
      : snapshot.logs[detailRecord.id] ?? ""
    const output = stripAnsi(formatLogOutput(rawOutput))
    const phase = detailRecord.message ?? (spinning ? "waiting for command" : "")
    const statusColor = commandStatusColor(detailRecord.status)
    const marker = spinning ? spinnerFrames[spinnerFrame] : detailRecord.status === "failed" ? "x" : "*"
    const commandHeight = compact ? 3 : 4
    const metricsHeight = compact ? 4 : 6

    return (
      <box style={{ width: "100%", height: "100%", flexDirection: "column", overflow: "hidden", backgroundColor: theme.base }}>
        <box style={{ height: compact ? 1 : 2, flexShrink: 0, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
          <text wrapMode="none" truncate style={{ fg: theme.mauve }}>{`runbox  ${sourceLabel}`}</text>
          {compact ? null : (
            <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>
              {source?.worktreePath ?? snapshot.state.runnerPath}
            </text>
          )}
        </box>
        <box
          title={` command: ${detailRecord.script} `}
          style={{
            height: commandHeight,
            flexShrink: 0,
            flexDirection: "column",
            border: true,
            borderStyle: "rounded",
            borderColor: statusColor,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text wrapMode="none" truncate style={{ fg: statusColor }}>
            {`${marker} ${detailRecord.status}${phase === "" ? "" : `  ${phase}`}`}
          </text>
          {compact ? null : (
            <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>
              {[
                detailRecord.args.length === 0 ? null : `args ${detailRecord.args.join(" ")}`,
                detailRecord.pid === null ? "pid -" : `pid ${detailRecord.pid}`,
                metrics === undefined ? "0 proc" : `${metrics.processCount} proc`,
                metrics === undefined ? "uptime -" : `uptime ${duration(metrics.uptimeSeconds)}`,
              ].filter(Boolean).join("  ")}
            </text>
          )}
        </box>
        <box
          title=" process metrics "
          style={{
            height: metricsHeight,
            flexShrink: 0,
            flexDirection: "column",
            border: true,
            borderStyle: "rounded",
            borderColor: theme.surface1,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text wrapMode="none" truncate style={{ fg: theme.teal }}>
            {`CPU ${metrics?.cpuPercent.toFixed(1).padStart(6) ?? "   0.0"}% |${graph(history.cpu, graphWidth, 100)}|`}
          </text>
          <text wrapMode="none" truncate style={{ fg: theme.blue }}>
            {`RAM ${(metrics === undefined ? "0K" : bytes(metrics.memoryBytes)).padStart(7)} |${graph(history.memory, graphWidth, 1)}|`}
          </text>
          {compact ? null : (
            <text wrapMode="none" truncate style={{ fg: theme.overlay1 }}>
              {`samples ${history.cpu.length}/60  aggregate process tree`}
            </text>
          )}
        </box>
        <box
          title=" retained output "
          style={{
            minHeight: 3,
            flexGrow: 1,
            flexDirection: "column",
            overflow: "hidden",
            border: true,
            borderStyle: "rounded",
            borderColor: theme.surface1,
            paddingLeft: 1,
          }}
        >
          <scrollbox
            ref={logScroll}
            id="dashboard-logs"
            focused
            stickyScroll
            stickyStart="bottom"
            scrollY
            style={{ flexGrow: 1 }}
          >
            <text wrapMode="char" style={{ fg: theme.text }}>
              {output === "" ? phase || "waiting for output..." : output}
            </text>
          </scrollbox>
        </box>
        <text wrapMode="none" truncate style={{ height: 1, flexShrink: 0, fg: message === null ? theme.overlay0 : theme.peach }}>
          {message ?? "esc commands  s stop  arrows/j/k/page/home/end scroll  q detach"}
        </text>
      </box>
    )
  }

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", overflow: "hidden", padding: 1, backgroundColor: theme.base }}>
      <text wrapMode="none" truncate style={{ fg: theme.mauve }}>runbox</text>
      <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>
        {`${sourceLabel}  ${source?.worktreePath ?? snapshot.state.repoRoot}`}
      </text>
      <box
        title={source?.stack === null || source?.stack === undefined ? " commands " : ` stack: ${source.stack.topBranch} `}
        style={{
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: theme.surface1,
          padding: 1,
          marginTop: 1,
          flexGrow: 1,
          overflow: "hidden",
        }}
      >
        {rows.length === 0 ? <text style={{ fg: theme.overlay0 }}>no package scripts</text> : null}
        {rows.map((row, index) => {
          const isSelected = index === Math.min(cursor, Math.max(rows.length - 1, 0))
          return (
            <CommandListRow
              key={row.key}
              label={row.type === "command" ? row.record.script : row.script}
              selected={isSelected}
              status={row.type === "command" ? row.record.status : null}
            />
          )
        })}
      </box>
      {message === null ? null : <text wrapMode="none" truncate style={{ fg: theme.peach }}>{message}</text>}
      <text wrapMode="none" truncate style={{ fg: theme.overlay0 }}>j/k move  enter open/start  q detach</text>
    </box>
  )
}
