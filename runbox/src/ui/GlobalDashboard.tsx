import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import type {
  ActionPlan,
  ActionReceipt,
  CommitRequest,
  GlobalView,
  InspectionQuery,
  OperatorIntent,
  PackageView,
  ScriptView,
} from "../application/model.ts"
import type { CommandRecord } from "../domain.ts"
import { formatLogOutput } from "../logFormat.ts"
import { CommandListRow, commandStatusColor } from "./CommandListRow.tsx"
import { useExit } from "./runApp.tsx"
import { theme } from "./theme.ts"

interface GlobalDashboardProps {
  readonly initial: GlobalView
  readonly onInspect: (query?: InspectionQuery) => Promise<GlobalView>
  readonly onPlan: (intent: OperatorIntent) => Promise<ActionPlan>
  readonly onCommit: (request: CommitRequest) => Promise<ActionPlan>
  readonly onExecute: (plan: ActionPlan) => Promise<ActionReceipt>
  readonly initialIntent?: OperatorIntent
}

interface CommandRow {
  readonly id: string
  readonly packagePath: string
  readonly script: ScriptView | null
  readonly record: CommandRecord | null
}

type SearchResult =
  | { readonly type: "repository"; readonly id: string; readonly label: string; readonly detail: string }
  | { readonly type: "worktree"; readonly path: string; readonly label: string; readonly detail: string }
  | { readonly type: "command"; readonly id: string; readonly label: string; readonly detail: string }

type Feedback = {
  readonly text: string
  readonly kind: "error" | "notice" | "status"
}

const sourceLabel = (view: GlobalView): string => {
  const source = view.selected?.state.source
  if (source === null || source === undefined) return "not prepared"
  if (source.kind === "stack" && source.stack !== null) {
    return `${source.stack.trunk} > ${source.stack.topBranch}@${source.commit.slice(0, 8)}`
  }
  return `${source.branch ?? "detached"}@${source.commit.slice(0, 8)}`
}

const rowsFor = (packages: ReadonlyArray<PackageView>, commands: Readonly<Record<string, CommandRecord>>): ReadonlyArray<CommandRow> => {
  const rows = packages.flatMap((pkg) => pkg.scripts.map((script): CommandRow => ({
    id: `${pkg.path === "" ? "." : pkg.path}:${script.name}`,
    packagePath: pkg.path,
    script,
    record: script.tracked,
  })))
  const visible = new Set(rows.map((row) => row.id))
  for (const record of Object.values(commands)) {
    if (!visible.has(record.id)) rows.push({ id: record.id, packagePath: record.packagePath, script: null, record })
  }
  return rows
}

export const sourceCursorForInspection = (
  current: number,
  worktrees: ReadonlyArray<{ readonly path: string }>,
  requestedPath: string | null | undefined,
  preserve: boolean,
): number => {
  if (preserve || requestedPath === null || requestedPath === undefined) return current
  const index = worktrees.findIndex((entry) => entry.path === requestedPath)
  return index < 0 ? current : index
}

const bytes = (value: number): string => value < 1024 * 1024
  ? `${Math.round(value / 1024)}K`
  : value < 1024 * 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)}M`
    : `${(value / 1024 / 1024 / 1024).toFixed(2)}G`

const duration = (seconds: number): string => seconds < 60
  ? `${Math.floor(seconds)}s`
  : seconds < 3_600
    ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
    : `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`

export const GlobalDashboard = ({ initial, initialIntent, onInspect, onPlan, onCommit, onExecute }: GlobalDashboardProps) => {
  const exit = useExit()
  const terminal = useTerminalDimensions()
  const initialRepositoryId = initial.selected?.state.repoId ?? initial.repositories[0]?.repoId ?? null
  const initialProjectCursor = initialRepositoryId === null
    ? 0
    : Math.max(0, initial.repositories.findIndex((entry) => entry.repoId === initialRepositoryId))
  const initialSourceCursor = initial.selected?.selectedWorktreePath === null || initial.selected?.selectedWorktreePath === undefined
    ? 0
    : Math.max(0, initial.selected.worktrees.findIndex((entry) => entry.path === initial.selected?.selectedWorktreePath))
  const initialRows = rowsFor(initial.selected?.packages ?? [], initial.selected?.state.commands ?? {})
  const initialCommandId = initialIntent?.type === "run"
    ? `${initialIntent.packagePath === "" ? "." : initialIntent.packagePath}:${initialIntent.script}`
    : initial.selected?.selectedCommand?.id ?? null
  const initialCommandCursor = initialCommandId === null
    ? 0
    : Math.max(0, initialRows.findIndex((entry) => entry.id === initialCommandId))
  const [view, setView] = useState(initial)
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId)
  const [projectCursor, setProjectCursor] = useState(initialProjectCursor)
  const [sourceCursor, setSourceCursor] = useState(initialSourceCursor)
  const [commandCursor, setCommandCursor] = useState(initialCommandCursor)
  const [focus, setFocus] = useState<"projects" | "sources" | "commands">(initialIntent === undefined ? "projects" : "commands")
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(initialCommandId)
  const [plan, setPlan] = useState<ActionPlan | null>(null)
  const [commitMode, setCommitMode] = useState<"manual" | null>(null)
  const [commitMessage, setCommitMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [search, setSearch] = useState<string | null>(null)
  const [searchCursor, setSearchCursor] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const initialStarted = useRef(false)
  const requestGeneration = useRef(0)
  const message = feedback?.text ?? null

  const selectedRepository = view.repositories.find((entry) => entry.repoId === repositoryId) ?? view.repositories[0]
  const worktrees = view.selected?.worktrees ?? []
  const selectedWorktree = worktrees[Math.min(sourceCursor, Math.max(0, worktrees.length - 1))]
  const inspectedWorktree = worktrees.find((entry) => entry.path === view.selected?.selectedWorktreePath)
  const commands = rowsFor(view.selected?.packages ?? [], view.selected?.state.commands ?? {})
  const selectedRow = commands[Math.min(commandCursor, Math.max(0, commands.length - 1))]
  const selectedRecord = selectedCommandId === null
    ? selectedRow?.record ?? null
    : view.selected?.state.commands[selectedCommandId] ?? selectedRow?.record ?? null
  const narrow = terminal.width < 88
  const wide = terminal.width >= 126
  const searchValue = search?.trim().toLowerCase() ?? ""
  const searchResults: ReadonlyArray<SearchResult> = [
    ...view.repositories.map((entry): SearchResult => ({
      type: "repository",
      id: entry.repoId,
      label: entry.name,
      detail: `${entry.activeCommandCount} active  ${entry.storage}`,
    })),
    ...worktrees.map((entry): SearchResult => ({
      type: "worktree",
      path: entry.path,
      label: entry.branch ?? "detached",
      detail: `${entry.head.slice(0, 8)}  ${entry.path}`,
    })),
    ...commands.map((entry): SearchResult => ({
      type: "command",
      id: entry.id,
      label: entry.id,
      detail: entry.record?.status ?? "available",
    })),
  ].filter((entry) => searchValue === "" || `${entry.label} ${entry.detail}`.toLowerCase().includes(searchValue)).slice(0, 12)

  const applyInspection = (next: GlobalView, query: InspectionQuery, preserveCursors = false) => {
    setView(next)
    const nextRepositoryId = query.repositoryId ?? next.selected?.state.repoId ?? next.repositories[0]?.repoId ?? null
    if (!preserveCursors) setRepositoryId(nextRepositoryId)
    if (!preserveCursors && nextRepositoryId !== null) {
      const nextProjectCursor = next.repositories.findIndex((entry) => entry.repoId === nextRepositoryId)
      if (nextProjectCursor >= 0) setProjectCursor(nextProjectCursor)
    }
    const nextWorktreePath = query.worktreePath ?? next.selected?.selectedWorktreePath
    setSourceCursor((current) => sourceCursorForInspection(
      current,
      next.selected?.worktrees ?? [],
      nextWorktreePath,
      preserveCursors,
    ))
    if (!preserveCursors && query.commandId !== undefined) {
      const nextRows = rowsFor(next.selected?.packages ?? [], next.selected?.state.commands ?? {})
      const nextCommandCursor = nextRows.findIndex((entry) => entry.id === query.commandId)
      if (nextCommandCursor >= 0) setCommandCursor(nextCommandCursor)
      setSelectedCommandId(query.commandId)
    }
  }

  const inspect = (query: InspectionQuery, interactive = true) => {
    const generation = ++requestGeneration.current
    if (interactive) {
      setBusy(true)
      setFeedback(null)
    }
    void onInspect(query).then((next) => {
      if (generation === requestGeneration.current) applyInspection(next, query, !interactive)
    }).catch((cause) => {
      if (interactive && generation === requestGeneration.current) setFeedback({ text: String(cause), kind: "error" })
    }).finally(() => {
      if (interactive && generation === requestGeneration.current) setBusy(false)
    })
  }

  useEffect(() => {
    const timer = setInterval(() => {
      if (plan !== null || busy || repositoryId === null) return
      inspect({
        repositoryId,
        ...(view.selected?.selectedWorktreePath === null || view.selected?.selectedWorktreePath === undefined ? {} : { worktreePath: view.selected.selectedWorktreePath }),
        ...(selectedCommandId === null ? {} : { commandId: selectedCommandId }),
      }, false)
    }, 2_000)
    return () => {
      clearInterval(timer)
    }
  }, [busy, plan, repositoryId, selectedCommandId, view.selected?.selectedWorktreePath])

  useEffect(() => {
    if (feedback?.kind !== "notice") return
    const timer = setTimeout(() => setFeedback(null), 1_500)
    return () => clearTimeout(timer)
  }, [feedback])

  const requestPlan = (intent: OperatorIntent) => {
    requestGeneration.current += 1
    setBusy(true)
    setFeedback(null)
    void onPlan(intent).then(setPlan).catch((cause) => setFeedback({ text: String(cause), kind: "error" })).finally(() => setBusy(false))
  }

  const runSelected = () => {
    if (selectedRepository === undefined || inspectedWorktree === undefined || selectedRow?.script === null || selectedRow === undefined) return
    requestPlan({
      type: "run",
      repoId: selectedRepository.repoId,
      worktreePath: inspectedWorktree.path,
      expectedHead: inspectedWorktree.head,
      packagePath: selectedRow.packagePath,
      script: selectedRow.script.name,
      args: [],
    })
  }

  const switchSelected = () => {
    if (selectedRepository === undefined || inspectedWorktree === undefined) return
    requestPlan({
      type: "switch",
      repoId: selectedRepository.repoId,
      worktreePath: inspectedWorktree.path,
      expectedHead: inspectedWorktree.head,
      packagePath: selectedRow?.packagePath ?? view.selected?.packages[0]?.path ?? "",
    })
  }

  const commandAction = (type: "stop" | "restart") => {
    if (selectedRepository === undefined || selectedRecord === null) return
    requestPlan({ type, repoId: selectedRepository.repoId, commandId: selectedRecord.id })
  }

  const executePlan = () => {
    if (plan === null) return
    requestGeneration.current += 1
    setBusy(true)
    void onExecute(plan).then((receipt) => {
      setView(receipt.view)
      setFeedback({ text: receipt.message, kind: "notice" })
      setPlan(null)
    }).catch((cause) => setFeedback({ text: String(cause), kind: "error" })).finally(() => setBusy(false))
  }

  useEffect(() => {
    if (initialIntent === undefined || initialStarted.current) return
    initialStarted.current = true
    requestGeneration.current += 1
    setBusy(true)
    setFeedback({ text: "Starting requested command...", kind: "status" })
    void onPlan(initialIntent).then((nextPlan) => {
      if (nextPlan.dirtySummary !== null) {
        setPlan(nextPlan)
        return null
      }
      return onExecute(nextPlan).then((receipt) => {
        setView(receipt.view)
        setFeedback({ text: receipt.message, kind: "notice" })
        return receipt
      })
    }).catch((cause) => setFeedback({ text: String(cause), kind: "error" })).finally(() => setBusy(false))
  }, [initialIntent, onExecute, onPlan])

  const commitSource = (mode: "manual" | "luna", message?: string) => {
    if (plan === null) return
    requestGeneration.current += 1
    setBusy(true)
    setFeedback(mode === "luna" ? { text: "Generating commit message with Luna...", kind: "status" } : null)
    void onCommit({ plan, mode, ...(message === undefined ? {} : { message }) }).then((next) => {
      setPlan(next)
      setCommitMode(null)
      setCommitMessage("")
      setFeedback({ text: "Changes committed. Review the updated source revision.", kind: "notice" })
    }).catch((cause) => setFeedback({ text: String(cause), kind: "error" })).finally(() => setBusy(false))
  }

  const move = (delta: number) => {
    if (focus === "projects") setProjectCursor((current) => Math.max(0, Math.min(view.repositories.length - 1, current + delta)))
    if (focus === "sources") setSourceCursor((current) => Math.max(0, Math.min(worktrees.length - 1, current + delta)))
    if (focus === "commands") {
      setCommandCursor((current) => Math.max(0, Math.min(commands.length - 1, current + delta)))
      setSelectedCommandId(null)
    }
  }

  useKeyboard((key) => {
    if (showHelp) {
      if (key.name === "escape" || key.name === "?" || key.name === "q") setShowHelp(false)
      return
    }
    if (search !== null) {
      if (key.name === "escape") setSearch(null)
      if (key.name === "down") setSearchCursor((current) => Math.min(searchResults.length - 1, current + 1))
      if (key.name === "up") setSearchCursor((current) => Math.max(0, current - 1))
      if (key.name === "return") {
        const result = searchResults[Math.min(searchCursor, Math.max(0, searchResults.length - 1))]
        setSearch(null)
        if (result?.type === "repository") {
          setRepositoryId(result.id)
          inspect({ repositoryId: result.id })
        } else if (result?.type === "worktree" && selectedRepository !== undefined) {
          const index = worktrees.findIndex((entry) => entry.path === result.path)
          if (index >= 0) setSourceCursor(index)
          inspect({ repositoryId: selectedRepository.repoId, worktreePath: result.path })
        } else if (result?.type === "command" && selectedRepository !== undefined) {
          setSelectedCommandId(result.id)
          inspect({ repositoryId: selectedRepository.repoId, commandId: result.id })
        }
      }
      return
    }
    if (plan !== null) {
      if (key.name === "escape") {
        if (commitMode !== null) setCommitMode(null)
        else setPlan(null)
      }
      if (commitMode === "manual") return
      if (plan.dirtySummary !== null && key.name === "c") setCommitMode("manual")
      if (plan.dirtySummary !== null && key.name === "a" && !busy) commitSource("luna")
      if (plan.dirtySummary === null && key.name === "return" && !busy) executePlan()
      return
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) return exit()
    if (key.name === "/" || (key.ctrl && key.name === "p")) {
      setSearch("")
      setSearchCursor(0)
      return
    }
    if (key.name === "?") {
      setShowHelp(true)
      return
    }
    if (key.name === "tab") {
      setFocus((current) => current === "projects" ? "sources" : current === "sources" ? "commands" : "projects")
      return
    }
    if (key.name === "j" || key.name === "down") return move(1)
    if (key.name === "k" || key.name === "up") return move(-1)
    if (key.name === "return") {
      if (focus === "projects") {
        const repository = view.repositories[Math.min(projectCursor, Math.max(0, view.repositories.length - 1))]
        if (repository !== undefined && repository.problem === null) {
          setRepositoryId(repository.repoId)
          setSourceCursor(0)
          setCommandCursor(0)
          setSelectedCommandId(null)
          inspect({ repositoryId: repository.repoId })
        }
      } else if (focus === "sources" && selectedRepository !== undefined && selectedWorktree !== undefined) {
        setCommandCursor(0)
        setSelectedCommandId(null)
        inspect({ repositoryId: selectedRepository.repoId, worktreePath: selectedWorktree.path })
      } else if (focus === "commands" && selectedRepository !== undefined && selectedRow !== undefined) {
        setSelectedCommandId(selectedRow.record?.id ?? null)
        if (selectedRow.record !== null) inspect({
          repositoryId: selectedRepository.repoId,
          ...(view.selected?.selectedWorktreePath === null || view.selected?.selectedWorktreePath === undefined ? {} : { worktreePath: view.selected.selectedWorktreePath }),
          commandId: selectedRow.record.id,
        })
      }
      return
    }
    if (key.name === "r" && key.shift) commandAction("restart")
    else if (key.name === "r") runSelected()
    if (key.name === "x") switchSelected()
    if (key.name === "s") commandAction("stop")
    if (key.name === "escape") setSelectedCommandId(null)
  })

  if (plan !== null) {
    return (
      <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: theme.base }}>
        <box title={` ${plan.title} `} style={{ width: Math.min(78, terminal.width - 4), height: Math.min(terminal.height - 2, Math.max(9, plan.effects.length + (plan.dirtySummary === null ? 7 : 14))), flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.mauve, padding: 1 }}>
          <text style={{ fg: theme.text }}>Planned effects</text>
          <text style={{ fg: theme.overlay0 }}> </text>
          {plan.effects.map((effect, index) => <text key={`${index}:${effect}`} style={{ fg: theme.subtext0 }}>{`${index + 1}. ${effect}`}</text>)}
          {plan.dirtySummary === null ? null : (
            <box title=" uncommitted changes " style={{ flexDirection: "column", border: true, borderColor: theme.yellow, paddingLeft: 1, paddingRight: 1 }}>
              <text wrapMode="char" style={{ fg: theme.yellow }}>{plan.dirtySummary}</text>
              {commitMode === "manual" ? (
                <input
                  focused
                  placeholder="Commit message"
                  value={commitMessage}
                  onInput={setCommitMessage}
                  onSubmit={() => commitSource("manual", commitMessage)}
                  textColor={theme.text}
                  backgroundColor={theme.surface0}
                />
              ) : <text style={{ fg: theme.overlay1 }}>c manual message   a Luna message   esc cancel</text>}
            </box>
          )}
          <text style={{ fg: theme.overlay0 }}> </text>
          <text style={{ fg: feedback?.kind === "error" ? theme.red : theme.yellow }}>{message ?? "This operation may restart repository commands."}</text>
          <text style={{ fg: theme.overlay1 }}>{busy ? "working..." : plan.dirtySummary === null ? "enter confirm   esc cancel" : "commit changes before execution"}</text>
        </box>
      </box>
    )
  }

  if (showHelp) {
    return (
      <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: theme.base }}>
        <box title=" runbox keys " style={{ width: Math.min(72, terminal.width - 4), height: Math.min(18, terminal.height - 2), flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.blue, padding: 1 }}>
          <text style={{ fg: theme.text }}>tab             next pane</text>
          <text style={{ fg: theme.text }}>j/k or arrows   move selection</text>
          <text style={{ fg: theme.text }}>enter           inspect selection</text>
          <text style={{ fg: theme.text }}>/ or ctrl+p     search everything visible</text>
          <text style={{ fg: theme.text }}>r               review run</text>
          <text style={{ fg: theme.text }}>x               review source switch</text>
          <text style={{ fg: theme.text }}>s / R           review stop / restart</text>
          <text style={{ fg: theme.text }}>q               detach; commands keep running</text>
          <text style={{ fg: theme.overlay1 }}>esc or ? close</text>
        </box>
      </box>
    )
  }

  if (search !== null) {
    return (
      <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: theme.base }}>
        <box title=" search " style={{ width: Math.min(92, terminal.width - 4), height: Math.min(19, terminal.height - 2), flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.blue, padding: 1 }}>
          <input focused placeholder="Project, branch, package, or command" value={search} onInput={(value) => { setSearch(value); setSearchCursor(0) }} textColor={theme.text} backgroundColor={theme.surface0} />
          <text style={{ fg: theme.overlay0 }}> </text>
          {searchResults.length === 0 ? <text style={{ fg: theme.overlay0 }}>no matches</text> : null}
          {searchResults.map((result, index) => (
            <text key={`${result.type}:${result.label}:${result.detail}`} wrapMode="none" truncate style={{ fg: index === searchCursor ? theme.text : theme.subtext0 }}>
              {`${index === searchCursor ? ">" : " "} ${result.type.padEnd(10)} ${result.label.padEnd(30)} ${result.detail}`}
            </text>
          ))}
          <text style={{ fg: theme.overlay1 }}>arrows move   enter inspect   esc close</text>
        </box>
      </box>
    )
  }

  const projectPane = (
    <box title=" repositories " style={{ flexDirection: "column", border: true, borderStyle: "rounded", borderColor: focus === "projects" ? theme.mauve : theme.surface1, paddingLeft: 1, paddingRight: 1, flexGrow: 1, overflow: "hidden" }}>
      {view.repositories.length === 0 ? <text style={{ fg: theme.overlay0 }}>no initialized repositories</text> : null}
      {view.repositories.map((repository, index) => {
        const selected = index === projectCursor
        const marker = repository.problem !== null ? "!" : repository.activeCommandCount > 0 ? "*" : "-"
        return (
          <text key={repository.repoId} wrapMode="none" truncate style={{ fg: selected ? theme.text : repository.problem === null ? theme.subtext0 : theme.red }}>
            {`${selected ? ">" : " "} ${marker} ${repository.name}  ${repository.activeCommandCount > 0 ? repository.activeCommandCount : ""}`}
          </text>
        )
      })}
    </box>
  )

  const sourcePane = (
    <box title=" execution sources " style={{ flexDirection: "column", border: true, borderStyle: "rounded", borderColor: focus === "sources" ? theme.mauve : theme.surface1, paddingLeft: 1, paddingRight: 1, flexGrow: 1, overflow: "hidden" }}>
      {view.selected?.state.source?.kind === "stack" && view.selected.state.source.stack !== null
        ? <text wrapMode="none" truncate style={{ fg: theme.blue }}>{`S stack ${sourceLabel(view)} [display]`}</text>
        : null}
      {worktrees.map((worktree, index) => {
        const selected = index === sourceCursor
        const activeCommit = worktree.isActiveSource && view.selected?.state.source?.kind === "worktree"
          ? view.selected.state.source.commit
          : null
        const flags = [
          activeCommit === null ? null : activeCommit === worktree.head ? "runner" : `runner@${activeCommit.slice(0, 8)}`,
          worktree.isEnvironmentSource ? "env" : null,
          worktree.locked === null ? null : "locked",
          worktree.prunable === null ? null : "prunable",
        ].filter(Boolean).join(",")
        return (
          <box key={worktree.path} style={{ flexDirection: "column" }}>
            <text wrapMode="none" truncate style={{ fg: selected ? theme.text : worktree.prunable === null ? theme.subtext0 : theme.red }}>
              {`${selected ? ">" : " "} ${worktree.branch ?? "detached"}`}
            </text>
            <text wrapMode="none" truncate style={{ fg: theme.overlay0 }}>{`    ${worktree.head.slice(0, 8)}${flags === "" ? "" : `  [${flags}]`}`}</text>
          </box>
        )
      })}
    </box>
  )

  const commandPane = (
    <box title=" packages / commands " style={{ flexDirection: "column", border: true, borderStyle: "rounded", borderColor: focus === "commands" ? theme.mauve : theme.surface1, paddingLeft: 1, paddingRight: 1, flexGrow: 1, overflow: "hidden" }}>
      {commands.length === 0 ? <text style={{ fg: theme.overlay0 }}>no package scripts in selected worktree</text> : null}
      {commands.map((row, index) => {
        const selected = index === commandCursor
        const status = row.record?.status ?? (row.script?.prepared === true ? "ready" : null)
        return (
          <CommandListRow key={row.id} label={row.id} selected={selected} status={status} />
        )
      })}
    </box>
  )

  const detailPane = (
    <box title=" detail / retained output " style={{ flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.surface1, paddingLeft: 1, paddingRight: 1, flexGrow: 1, overflow: "hidden" }}>
      <text wrapMode="none" truncate style={{ fg: theme.mauve }}>{selectedRow?.id ?? selectedRepository?.name ?? "select a repository"}</text>
      <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>{`active  ${sourceLabel(view)}`}</text>
      <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>{`env     ${selectedRepository?.environmentSourceRoot ?? "not configured"}`}</text>
        <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>{`storage ${selectedRepository?.storage ?? "-"}  daemon ${selectedRepository?.daemon ?? "-"}  setup ${view.selected?.preparation.setup ?? "-"}`}</text>
      {selectedRecord === null ? (
        <text style={{ fg: theme.overlay1 }}>{selectedRow?.script?.command ?? "enter a command to inspect retained output"}</text>
      ) : (
        <>
          <text wrapMode="none" truncate style={{ fg: commandStatusColor(selectedRecord.status) }}>{`${selectedRecord.status}  pid ${selectedRecord.pid ?? "-"}  cpu ${view.selected?.selectedMetrics?.cpuPercent.toFixed(1) ?? "0.0"}%`}</text>
          <text wrapMode="none" truncate style={{ fg: theme.subtext0 }}>{`memory ${bytes(view.selected?.selectedMetrics?.memoryBytes ?? 0)}  processes ${view.selected?.selectedMetrics?.processCount ?? 0}  uptime ${duration(view.selected?.selectedMetrics?.uptimeSeconds ?? 0)}`}</text>
          <scrollbox id="global-dashboard-logs" focused={focus === "commands"} stickyScroll stickyStart="bottom" scrollY style={{ flexGrow: 1 }}>
            <text wrapMode="char" style={{ fg: theme.text }}>{formatLogOutput(view.selected?.selectedLog ?? "") || selectedRecord.message || "waiting for output..."}</text>
          </scrollbox>
        </>
      )}
      {(view.selected?.problems ?? []).map((entry) => <text key={`${entry.code}:${entry.path}`} wrapMode="none" truncate style={{ fg: theme.red }}>{`${entry.code}: ${entry.message}`}</text>)}
    </box>
  )

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", overflow: "hidden", backgroundColor: theme.base }}>
      <box style={{ height: 2, flexShrink: 0, flexDirection: "column", backgroundColor: theme.base }}>
        <box style={{ height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, overflow: "hidden", backgroundColor: theme.base }}>
          <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1, fg: theme.mauve }}>{`runbox  GLOBAL   ${view.repositories.length} repositories   ${view.repositories.reduce((sum, entry) => sum + entry.activeCommandCount, 0)} active`}</text>
        </box>
        <box style={{ height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, overflow: "hidden", backgroundColor: theme.base }}>
          <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1, fg: theme.overlay1 }}>{selectedRepository === undefined ? "No initialized repositories. Run 'runbox init' inside a Git repository." : `${selectedRepository.key}  ${busy ? "refreshing..." : sourceLabel(view)}`}</text>
        </box>
      </box>
      {narrow ? (
        <box style={{ flexGrow: 1, overflow: "hidden" }}>
          {focus === "projects" ? projectPane : focus === "sources" ? sourcePane : commandPane}
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "row", overflow: "hidden" }}>
          <box style={{ width: wide ? 34 : 28, flexShrink: 0, flexDirection: "column" }}>{projectPane}{sourcePane}</box>
          <box style={wide ? { width: 54, flexGrow: 0 } : { flexGrow: 1 }}>{commandPane}</box>
          {wide ? <box style={{ flexGrow: 1 }}>{detailPane}</box> : null}
        </box>
      )}
      {narrow && selectedCommandId !== null ? <box style={{ height: Math.max(6, Math.floor(terminal.height / 3)) }}>{detailPane}</box> : null}
      <box style={{ height: 1, flexShrink: 0, overflow: "hidden", backgroundColor: theme.base }}>
        <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1, fg: feedback?.kind === "error" ? theme.red : message === null ? theme.overlay0 : theme.peach }}>
          {message ?? "tab pane  j/k move  enter inspect  / search  ? help  r run  x switch  s stop  R restart  q detach"}
        </text>
      </box>
    </box>
  )
}
