import { useCallback, useMemo, useRef, useState } from "react"
import { theme, useExit, useModal, type ModeSpec } from "@heherdr/framework"
import type { StackBranchRow, StackNavigatorData } from "./model.ts"

type Mode = "normal" | "filter"

export type StackNavigatorAction =
  | { readonly type: "open"; readonly row: StackBranchRow }
  | { readonly type: "create"; readonly row: StackBranchRow }

export interface StackUiProps {
  readonly data: StackNavigatorData
  readonly onAction: (action: StackNavigatorAction) => void
  readonly onRefresh: () => Promise<StackNavigatorData>
}

const currentRowIndex = (data: StackNavigatorData, stackIndex: number): number => {
  const rows = data.stacks[stackIndex]?.rows ?? []
  const current = rows.findIndex((row) => row.isCurrent)
  return current < 0 ? 0 : current
}

export const StackUi = ({ data, onAction, onRefresh }: StackUiProps) => {
  const { exit } = useExit()
  const [list, setList] = useState(data)
  const [stackIndex, setStackIndex] = useState<number | null>(data.stacks.length === 1 ? 0 : null)
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(() =>
    data.stacks.length === 1 ? currentRowIndex(data, 0) : 0,
  )
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const setModeRef = useRef<(mode: Mode) => void>(() => {})

  const choosingStack = stackIndex === null
  const q = query.toLowerCase()
  const visibleStacks = useMemo(
    () =>
      list.stacks
        .map((stack, index) => ({ stack, index }))
        .filter(({ stack }) => q === "" || stack.label.toLowerCase().includes(q)),
    [list.stacks, q],
  )
  const visibleRows = useMemo(
    () =>
      (stackIndex === null ? [] : (list.stacks[stackIndex]?.rows ?? [])).filter(
        (row) => q === "" || row.branch.toLowerCase().includes(q),
      ),
    [list.stacks, stackIndex, q],
  )
  const visibleLength = choosingStack ? visibleStacks.length : visibleRows.length
  const index = Math.min(cursor, Math.max(visibleLength - 1, 0))
  const selectedStack = choosingStack ? visibleStacks[index] : undefined
  const selectedRow = choosingStack ? undefined : visibleRows[index]

  const move = useCallback(
    (delta: number) =>
      setCursor(() => {
        if (visibleLength === 0) return 0
        const next = index + delta
        return next < 0 ? 0 : next >= visibleLength ? visibleLength - 1 : next
      }),
    [index, visibleLength],
  )

  const choose = useCallback(() => {
    if (selectedStack !== undefined) {
      setStackIndex(selectedStack.index)
      setQuery("")
      setCursor(currentRowIndex(list, selectedStack.index))
      setStatus(null)
      return
    }
    if (selectedRow === undefined) return
    if (selectedRow.worktree === null) {
      setStatus(
        selectedRow.canCreateWorktree
          ? "no worktree — press c to create and open one"
          : selectedRow.isMerged
            ? "merged branch has no worktree"
            : "branch no longer exists locally",
      )
      return
    }
    onAction({ type: "open", row: selectedRow })
    exit()
  }, [selectedStack, selectedRow, list, onAction, exit])

  const create = useCallback(() => {
    if (selectedRow === undefined || !selectedRow.canCreateWorktree) return
    onAction({ type: "create", row: selectedRow })
    exit()
  }, [selectedRow, onAction, exit])

  const refresh = useCallback(() => {
    if (busy) return
    setBusy(true)
    void onRefresh()
      .then((next) => {
        const selectedStackKey = stackIndex === null ? null : list.stacks[stackIndex]?.key
        const nextStackIndex =
          selectedStackKey === null || selectedStackKey === undefined
            ? next.stacks.length === 1
              ? 0
              : null
            : next.stacks.findIndex((stack) => stack.key === selectedStackKey)
        const normalizedStackIndex =
          nextStackIndex === -1 ? (next.stacks.length === 1 ? 0 : null) : nextStackIndex
        setList(next)
        setStackIndex(normalizedStackIndex)
        setCursor(
          normalizedStackIndex === null ? 0 : currentRowIndex(next, normalizedStackIndex),
        )
        setStatus("reloaded local stack state")
      })
      .catch((error: unknown) => setStatus(String(error).split("\n")[0] ?? String(error)))
      .finally(() => setBusy(false))
  }, [busy, onRefresh, stackIndex, list.stacks])

  const back = useCallback(() => {
    if (!choosingStack && list.stacks.length > 1) {
      setStackIndex(null)
      setQuery("")
      setCursor(0)
      setStatus(null)
    } else {
      exit()
    }
  }, [choosingStack, list.stacks.length, exit])

  const modes = useMemo<Record<Mode, ModeSpec>>(
    () => ({
      normal: {
        bindings: {
          j: { description: "down", run: () => move(1) },
          k: { description: "up", run: () => move(-1) },
          down: { description: "down", run: () => move(1), hidden: true },
          up: { description: "up", run: () => move(-1), hidden: true },
          "g g": { description: "top", run: () => setCursor(0) },
          G: { description: "bottom", run: () => setCursor(Math.max(visibleLength - 1, 0)) },
          "/": { description: "filter", run: () => setModeRef.current("filter") },
          return: { description: choosingStack ? "select" : "open", run: choose },
          c: { description: "create worktree", run: create, hidden: choosingStack },
          r: { description: "reload", run: refresh },
          q: { description: "quit", run: exit },
          escape: { description: choosingStack ? "quit" : "back", run: back, hidden: true },
        },
      },
      filter: {
        onText: (char) => setQuery((value) => value + char),
        onBackspace: () => setQuery((value) => value.slice(0, -1)),
        bindings: {
          escape: { description: "cancel", run: () => setModeRef.current("normal") },
          return: { description: "accept", run: () => setModeRef.current("normal") },
          "ctrl+u": { description: "clear", run: () => setQuery("") },
        },
      },
    }),
    [move, visibleLength, choosingStack, choose, create, refresh, exit, back],
  )

  const modal = useModal<Mode>({ initial: "normal", modes })
  setModeRef.current = modal.setMode

  return (
    <box style={{ flexDirection: "column", padding: 1, backgroundColor: theme.base }}>
      <text style={{ fg: theme.mauve }}>
        {choosingStack ? `stacks — ${list.repoName}` : `stack branches — ${list.repoName}`}
      </text>
      <text style={{ fg: modal.mode === "filter" ? theme.text : theme.overlay0 }}>
        {query === "" && modal.mode !== "filter" ? "/ filter" : `/${query}`}
      </text>

      <box style={{ flexDirection: "column", paddingTop: 1 }}>
        {visibleLength === 0 ? (
          <text style={{ fg: theme.overlay0 }}>no matches</text>
        ) : choosingStack ? (
          visibleStacks.map(({ stack }, rowIndex) => (
            <text
              key={stack.key}
              style={{ fg: rowIndex === index ? theme.text : theme.subtext0 }}
            >
              {`${rowIndex === index ? "▸ " : "  "}${stack.label}`}
            </text>
          ))
        ) : (
          visibleRows.map((row, rowIndex) => {
            const state = [
              row.isCurrent ? "current" : null,
              row.worktree?.open_workspace_id !== undefined
                ? "● open"
                : row.worktree !== null
                  ? "worktree"
                  : row.canCreateWorktree
                    ? "no worktree"
                    : "unavailable",
              row.isMerged ? "merged" : null,
              row.pullRequestNumber === null ? null : `#${row.pullRequestNumber}`,
              row.isTrunk ? "trunk" : null,
            ]
              .filter((value) => value !== null)
              .join("  ")
            return (
              <text
                key={row.branch}
                style={{
                  fg: rowIndex === index ? theme.text : row.isMerged ? theme.overlay0 : theme.subtext0,
                }}
              >
                {`${rowIndex === index ? "▸ " : "  "}${row.branch}${state === "" ? "" : `  ${state}`}`}
              </text>
            )
          })
        )}
      </box>

      {status !== null ? <text style={{ fg: theme.peach, paddingTop: 1 }}>{status}</text> : null}
      <text style={{ fg: theme.overlay0, paddingTop: 1 }}>
        {busy
          ? "working…"
          : modal.hints.map(([spec, description]) => `${spec} ${description}`).join("   ") +
            (modal.pending.length > 0 ? `   [${modal.pending.join(" ")}]` : "")}
      </text>
    </box>
  )
}
