import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, type ReactNode } from "react"
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

type Pane = "projects" | "sources" | "commands" | "detail"
type FilterablePane = Exclude<Pane, "detail">
type PaneFilters = Record<FilterablePane, string>

const paneOrder: ReadonlyArray<Pane> = ["projects", "sources", "commands", "detail"]

interface PaneFrameProps {
  readonly shortcut: string
  readonly label: string
  readonly count?: number
  readonly focused: boolean
  readonly filter?: {
    readonly value: string
    readonly editing: boolean
    readonly onInput: (value: string) => void
    readonly onClose: () => void
  }
  readonly children: ReactNode
}

const PaneFrame = ({ shortcut, label, count, focused, filter, children }: PaneFrameProps) => {
  const filtered = (filter?.value.trim().length ?? 0) > 0
  const suffix = filtered ? " (filtered)" : count === undefined ? "" : ` (${count})`
  const title = `${shortcut} ${label}${suffix}`
  return (
    <box style={{ minHeight: 4, flexGrow: 1, position: "relative", overflow: "hidden", backgroundColor: theme.base }}>
      <box style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        overflow: "hidden",
        border: true,
        borderStyle: "rounded",
        borderColor: focused ? theme.mauve : theme.surface1,
        backgroundColor: theme.base,
      }}>
        <box style={{ minHeight: 1, flexGrow: 1, flexDirection: "column", overflow: "hidden", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.base }}>
          {children}
        </box>
      </box>
      {filter?.editing === true ? (
        <box style={{ position: "absolute", top: 0, left: 2, zIndex: 1, width: "85%", height: 1, flexDirection: "row", overflow: "hidden", backgroundColor: theme.base }}>
          <text wrapMode="none">
            <span> </span>
            <span fg={theme.yellow}>f</span>
            <span fg={theme.text}> filtering: </span>
          </text>
          <input
            focused
            value={filter.value}
            onInput={filter.onInput}
            onSubmit={filter.onClose}
            keyBindings={[{ name: "escape", action: "submit" }]}
            placeholder="type to filter"
            textColor={theme.text}
            backgroundColor={theme.base}
            style={{ minWidth: 1, flexGrow: 1 }}
          />
          <text> </text>
        </box>
      ) : (
        <box style={{ position: "absolute", top: 0, left: 2, zIndex: 1, width: title.length + 2, maxWidth: "85%", height: 1, overflow: "hidden", backgroundColor: theme.base }}>
          <text wrapMode="none" truncate>
            <span> </span>
            <span fg={focused ? theme.yellow : theme.mauve}>{shortcut}</span>
            <span fg={focused ? theme.text : theme.subtext0}>{` ${label}${suffix}`}</span>
            <span> </span>
          </text>
        </box>
      )}
    </box>
  )
}

const HotkeyHint = ({ shortcut, label }: { readonly shortcut: string; readonly label: string }) => (
  <>
    <span fg={theme.mauve}>{shortcut}</span>
    <span fg={theme.overlay0}>{` ${label}  `}</span>
  </>
)

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

const normalizedFilter = (value: string): string => value.trim().toLowerCase()

const includesFilter = (value: string, filter: string): boolean => {
  const query = normalizedFilter(filter)
  return query === "" || value.toLowerCase().includes(query)
}

const filteredRepositories = (repositories: GlobalView["repositories"], filter: string) => repositories.filter((entry) => includesFilter(
  `${entry.name} ${entry.key} ${entry.repositoryRoot} ${entry.storage} ${entry.daemon} ${entry.problem?.code ?? ""} ${entry.problem?.message ?? ""} ${entry.problem?.path ?? ""}`,
  filter,
))

const filteredWorktrees = (worktrees: NonNullable<GlobalView["selected"]>["worktrees"], filter: string) => worktrees.filter((entry) => includesFilter(
  `${entry.branch ?? "detached"} ${entry.head} ${entry.path} ${entry.locked ?? ""} ${entry.prunable ?? ""}`,
  filter,
))

const filteredCommands = (commands: ReadonlyArray<CommandRow>, filter: string) => commands.filter((entry) => includesFilter(
  `${entry.id} ${entry.script?.command ?? ""} ${entry.record?.status ?? "available"}`,
  filter,
))

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
  const [focus, setFocus] = useState<Pane>(initialIntent === undefined ? "projects" : "detail")
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(initialCommandId)
  const [plan, setPlan] = useState<ActionPlan | null>(null)
  const [commitMode, setCommitMode] = useState<"manual" | null>(null)
  const [commitMessage, setCommitMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [search, setSearch] = useState<string | null>(null)
  const [searchCursor, setSearchCursor] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [filters, setFilters] = useState<PaneFilters>({ projects: "", sources: "", commands: "" })
  const [filtering, setFiltering] = useState<FilterablePane | null>(null)
  const initialStarted = useRef(false)
  const requestGeneration = useRef(0)
  const message = feedback?.text ?? null

  const selectedRepository = view.repositories.find((entry) => entry.repoId === repositoryId) ?? view.repositories[0]
  const worktrees = view.selected?.worktrees ?? []
  const visibleRepositories = filteredRepositories(view.repositories, filters.projects)
  const visibleWorktrees = filteredWorktrees(worktrees, filters.sources)
  const selectedWorktree = visibleWorktrees[Math.min(sourceCursor, Math.max(0, visibleWorktrees.length - 1))]
  const inspectedWorktree = worktrees.find((entry) => entry.path === view.selected?.selectedWorktreePath)
  const commands = rowsFor(view.selected?.packages ?? [], view.selected?.state.commands ?? {})
  const visibleCommands = filteredCommands(commands, filters.commands)
  const selectedRow = visibleCommands[Math.min(commandCursor, Math.max(0, visibleCommands.length - 1))]
  const selectedRecord = selectedCommandId === null
    ? selectedRow?.record ?? null
    : view.selected?.state.commands[selectedCommandId] ?? selectedRow?.record ?? null
  const narrow = terminal.width < 88
  const wide = terminal.width >= 126
  const stackVisible = view.selected?.state.source?.kind === "stack"
    && view.selected.state.source.stack !== null
    && includesFilter(`stack ${sourceLabel(view)}`, filters.sources)
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
    const nextRepositories = filteredRepositories(next.repositories, filters.projects)
    const highlightedRepositoryId = preserveCursors
      ? visibleRepositories[Math.min(projectCursor, Math.max(0, visibleRepositories.length - 1))]?.repoId
      : nextRepositoryId
    if (highlightedRepositoryId !== null && highlightedRepositoryId !== undefined) {
      const nextProjectCursor = nextRepositories.findIndex((entry) => entry.repoId === highlightedRepositoryId)
      setProjectCursor(Math.max(0, nextProjectCursor))
    }
    const nextWorktrees = filteredWorktrees(next.selected?.worktrees ?? [], filters.sources)
    const highlightedWorktreePath = preserveCursors
      ? selectedWorktree?.path
      : query.worktreePath ?? next.selected?.selectedWorktreePath
    if (highlightedWorktreePath !== null && highlightedWorktreePath !== undefined) {
      const nextSourceCursor = nextWorktrees.findIndex((entry) => entry.path === highlightedWorktreePath)
      setSourceCursor(Math.max(0, nextSourceCursor))
    }
    const nextRows = filteredCommands(rowsFor(next.selected?.packages ?? [], next.selected?.state.commands ?? {}), filters.commands)
    const highlightedCommandId = preserveCursors ? selectedRow?.id : query.commandId
    if (highlightedCommandId !== undefined) {
      const nextCommandCursor = nextRows.findIndex((entry) => entry.id === highlightedCommandId)
      setCommandCursor(Math.max(0, nextCommandCursor))
    }
    if (!preserveCursors && query.commandId !== undefined) {
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
    if (selectedRepository === undefined || selectedWorktree === undefined) return
    const planFor = (next: GlobalView, targetPath: string) => {
      const target = next.selected?.worktrees.find((entry) => entry.path === targetPath)
      const packagePath = next.selected?.packages[0]?.path
      if (target === undefined || packagePath === undefined) {
        setFeedback({ text: "Selected worktree has no discoverable package scripts.", kind: "error" })
        setBusy(false)
        return
      }
      requestPlan({
        type: "switch",
        repoId: selectedRepository.repoId,
        worktreePath: target.path,
        expectedHead: target.head,
        packagePath,
      })
    }
    if (selectedWorktree.path === view.selected?.selectedWorktreePath) {
      planFor(view, selectedWorktree.path)
      return
    }
    const generation = ++requestGeneration.current
    setBusy(true)
    setFeedback({ text: "Inspecting selected worktree...", kind: "status" })
    const query = { repositoryId: selectedRepository.repoId, worktreePath: selectedWorktree.path }
    void onInspect(query).then((next) => {
      if (generation !== requestGeneration.current) return
      applyInspection(next, query)
      planFor(next, selectedWorktree.path)
    }).catch((cause) => {
      if (generation === requestGeneration.current) setFeedback({ text: String(cause), kind: "error" })
    }).finally(() => {
      if (generation === requestGeneration.current) setBusy(false)
    })
  }

  const commandAction = (type: "stop" | "restart") => {
    const record = focus === "commands" ? selectedRow?.record ?? null : selectedRecord
    if (selectedRepository === undefined || record === null) return
    requestPlan({ type, repoId: selectedRepository.repoId, commandId: record.id })
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

  const updateFilter = (pane: FilterablePane, value: string) => {
    if (pane === "projects") {
      const currentId = visibleRepositories[Math.min(projectCursor, Math.max(0, visibleRepositories.length - 1))]?.repoId
      const nextRows = filteredRepositories(view.repositories, value)
      const nextIndex = currentId === undefined ? -1 : nextRows.findIndex((entry) => entry.repoId === currentId)
      setProjectCursor(Math.max(0, nextIndex))
    } else if (pane === "sources") {
      const currentPath = selectedWorktree?.path
      const nextRows = filteredWorktrees(worktrees, value)
      const nextIndex = currentPath === undefined ? -1 : nextRows.findIndex((entry) => entry.path === currentPath)
      setSourceCursor(Math.max(0, nextIndex))
    } else {
      const currentId = selectedRow?.id
      const nextRows = filteredCommands(commands, value)
      const nextIndex = currentId === undefined ? -1 : nextRows.findIndex((entry) => entry.id === currentId)
      setCommandCursor(Math.max(0, nextIndex))
      setSelectedCommandId(null)
    }
    setFilters((current) => ({ ...current, [pane]: value }))
  }

  const move = (delta: number) => {
    if (focus === "projects") setProjectCursor((current) => Math.max(0, Math.min(visibleRepositories.length - 1, current + delta)))
    if (focus === "sources") setSourceCursor((current) => Math.max(0, Math.min(visibleWorktrees.length - 1, current + delta)))
    if (focus === "commands") {
      setCommandCursor((current) => Math.max(0, Math.min(visibleCommands.length - 1, current + delta)))
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
    if (filtering !== null) {
      if (key.name === "escape") setFiltering(null)
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
    if (key.name === "f" && focus !== "detail") {
      setFiltering(focus)
      return
    }
    if (key.name === "p") {
      setFocus("projects")
      return
    }
    if (key.name === "w") {
      setFocus("sources")
      return
    }
    if (key.name === "c") {
      setFocus("commands")
      return
    }
    if (key.name === "o") {
      setFocus("detail")
      return
    }
    if (key.name === "tab") {
      setFocus((current) => {
        const currentIndex = paneOrder.indexOf(current)
        const delta = key.shift ? -1 : 1
        return paneOrder[(currentIndex + delta + paneOrder.length) % paneOrder.length] ?? "projects"
      })
      return
    }
    if (key.name === "j" || key.name === "down") return move(1)
    if (key.name === "k" || key.name === "up") return move(-1)
    if (key.name === "return") {
      if (focus === "projects") {
        const repository = visibleRepositories[Math.min(projectCursor, Math.max(0, visibleRepositories.length - 1))]
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
    if (key.name === "r" && key.shift && (focus === "commands" || focus === "detail")) commandAction("restart")
    else if (key.name === "r" && focus === "commands") runSelected()
    if (key.name === "x" && focus === "sources") switchSelected()
    if (key.name === "s" && (focus === "commands" || focus === "detail")) commandAction("stop")
    if (key.name === "escape") setSelectedCommandId(null)
  })

  if (plan !== null) {
    const modalHeight = Math.max(1, terminal.height - 2)
    const dirtyHeight = plan.dirtySummary === null
      ? 0
      : Math.min(
        Math.max(4, modalHeight - plan.effects.length - 9),
        Math.max(4, plan.dirtySummary.split("\n").length + 3),
      )
    return (
      <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: theme.base }}>
        <box title={` ${plan.title} `} style={{ width: Math.min(78, terminal.width - 4), height: modalHeight, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.mauve, padding: 1 }}>
          <text style={{ fg: theme.text }}>Planned effects</text>
          <text style={{ fg: theme.overlay0 }}> </text>
          {plan.effects.map((effect, index) => <text key={`${index}:${effect}`} style={{ fg: theme.subtext0 }}>{`${index + 1}. ${effect}`}</text>)}
          {plan.dirtySummary === null ? null : (
            <box title=" uncommitted changes " style={{ height: dirtyHeight, flexShrink: 0, flexDirection: "column", overflow: "hidden", border: true, borderColor: theme.yellow, paddingLeft: 1, paddingRight: 1 }}>
              <scrollbox scrollY style={{ minHeight: 1, flexGrow: 1 }}>
                <text wrapMode="char" style={{ fg: theme.yellow }}>{plan.dirtySummary}</text>
              </scrollbox>
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
              ) : (
                <text style={{ height: 1, flexShrink: 0 }}>
                  <HotkeyHint shortcut="c" label="manual message" />
                  <HotkeyHint shortcut="a" label="Luna message" />
                  <HotkeyHint shortcut="esc" label="cancel" />
                </text>
              )}
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
          <text><HotkeyHint shortcut="p" label="repositories" /></text>
          <text><HotkeyHint shortcut="w" label="worktrees" /></text>
          <text><HotkeyHint shortcut="c" label="commands" /></text>
          <text><HotkeyHint shortcut="o" label="retained output" /></text>
          <text style={{ fg: theme.text }}>tab / shift-tab cycle panes</text>
          <text style={{ fg: theme.text }}>j/k or arrows   move selection</text>
          <text style={{ fg: theme.text }}>enter           inspect selection</text>
          <text style={{ fg: theme.text }}>f               filter focused pane</text>
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
    <PaneFrame
      shortcut="p"
      label="repositories"
      count={visibleRepositories.length}
      focused={focus === "projects"}
      filter={{ value: filters.projects, editing: filtering === "projects", onInput: (value) => updateFilter("projects", value), onClose: () => setFiltering(null) }}
    >
      {view.repositories.length === 0 ? <text style={{ fg: theme.overlay0 }}>no initialized repositories</text> : null}
      {view.repositories.length > 0 && visibleRepositories.length === 0 ? <text style={{ fg: theme.overlay0 }}>no matching repositories</text> : null}
      {visibleRepositories.map((repository, index) => {
        const selected = index === projectCursor
        const marker = repository.problem !== null ? "!" : repository.activeCommandCount > 0 ? "*" : "-"
        return (
          <text key={repository.repoId} wrapMode="none" truncate style={{ fg: selected ? theme.text : repository.problem === null ? theme.subtext0 : theme.red }}>
            {`${selected ? ">" : " "} ${marker} ${repository.name}  ${repository.activeCommandCount > 0 ? repository.activeCommandCount : ""}`}
          </text>
        )
      })}
    </PaneFrame>
  )

  const sourcePane = (
    <PaneFrame
      shortcut="w"
      label="sources"
      count={visibleWorktrees.length + (stackVisible ? 1 : 0)}
      focused={focus === "sources"}
      filter={{ value: filters.sources, editing: filtering === "sources", onInput: (value) => updateFilter("sources", value), onClose: () => setFiltering(null) }}
    >
      {stackVisible
        ? <text wrapMode="none" truncate style={{ fg: theme.blue }}>{`S stack ${sourceLabel(view)} [display]`}</text>
        : null}
      {worktrees.length > 0 && visibleWorktrees.length === 0 && !stackVisible ? <text style={{ fg: theme.overlay0 }}>no matching sources</text> : null}
      {visibleWorktrees.map((worktree, index) => {
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
    </PaneFrame>
  )

  const commandPane = (
    <PaneFrame
      shortcut="c"
      label="packages / commands"
      count={visibleCommands.length}
      focused={focus === "commands"}
      filter={{ value: filters.commands, editing: filtering === "commands", onInput: (value) => updateFilter("commands", value), onClose: () => setFiltering(null) }}
    >
      {commands.length === 0 ? <text style={{ fg: theme.overlay0 }}>no package scripts in selected worktree</text> : null}
      {commands.length > 0 && visibleCommands.length === 0 ? <text style={{ fg: theme.overlay0 }}>no matching commands</text> : null}
      {visibleCommands.map((row, index) => {
        const selected = index === commandCursor
        const status = row.record?.status ?? (row.script?.prepared === true ? "ready" : null)
        return (
          <CommandListRow key={row.id} label={row.id} selected={selected} status={status} />
        )
      })}
    </PaneFrame>
  )

  const detailPane = (
    <PaneFrame shortcut="o" label="retained output" focused={focus === "detail"}>
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
          <scrollbox id="global-dashboard-logs" focused={focus === "detail"} stickyScroll stickyStart="bottom" scrollY style={{ flexGrow: 1 }}>
            <text wrapMode="char" style={{ fg: theme.text }}>{formatLogOutput(view.selected?.selectedLog ?? "") || selectedRecord.message || "waiting for output..."}</text>
          </scrollbox>
        </>
      )}
      {(view.selected?.problems ?? []).map((entry) => <text key={`${entry.code}:${entry.path}`} wrapMode="none" truncate style={{ fg: theme.red }}>{`${entry.code}: ${entry.message}`}</text>)}
    </PaneFrame>
  )

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", overflow: "hidden", backgroundColor: theme.base }}>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "column", backgroundColor: theme.base }}>
        <box style={{ height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, overflow: "hidden", backgroundColor: theme.base }}>
          <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1, fg: theme.overlay1 }}>{selectedRepository === undefined ? "No initialized repositories. Run 'runbox init' inside a Git repository." : `${selectedRepository.key}  ${busy ? "refreshing..." : sourceLabel(view)}`}</text>
        </box>
      </box>
      {narrow ? (
        <box style={{ flexGrow: 1, overflow: "hidden", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.base }}>
          {focus === "projects" ? projectPane : focus === "sources" ? sourcePane : focus === "commands" ? commandPane : detailPane}
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "row", gap: 1, overflow: "hidden", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.base }}>
          <box style={{ width: wide ? 34 : 28, minHeight: 9, flexShrink: 0, flexDirection: "column", gap: 1, backgroundColor: theme.base }}>{projectPane}{sourcePane}</box>
          <box style={wide ? { width: 54, flexGrow: 0 } : { minWidth: 0, flexGrow: 1 }}>{wide || focus !== "detail" ? commandPane : detailPane}</box>
          {wide ? <box style={{ flexGrow: 1 }}>{detailPane}</box> : null}
        </box>
      )}
      <box style={{ height: 1, flexShrink: 0, overflow: "hidden", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.base }}>
        {message === null ? (
          <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1 }}>
            <HotkeyHint shortcut="p" label="repos" />
            <HotkeyHint shortcut="w" label="sources" />
            <HotkeyHint shortcut="c" label="commands" />
            <HotkeyHint shortcut="o" label="output" />
            {focus === "sources" ? <HotkeyHint shortcut="x" label="switch" /> : null}
            {focus === "commands" ? <HotkeyHint shortcut="r" label="run" /> : null}
            {focus === "commands" || focus === "detail" ? <HotkeyHint shortcut="s/R" label="stop/restart" /> : null}
            {focus !== "detail" ? <HotkeyHint shortcut="f" label="filter" /> : null}
            <HotkeyHint shortcut="/" label="search" />
            <HotkeyHint shortcut="?" label="help" />
            <HotkeyHint shortcut="q" label="detach" />
          </text>
        ) : (
          <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1, fg: feedback?.kind === "error" ? theme.red : theme.peach }}>{message}</text>
        )}
      </box>
    </box>
  )
}
