import { useCallback, useMemo, useState } from "react"
import { theme, useExit, useModal, type ModeSpec } from "@heherdr/framework"
import type { WorktreeInfo } from "@heherdr/framework/herdr/Client.ts"

type Mode = "select"

interface WorktreeSelectorUiProps {
  readonly currentPath: string
  readonly worktrees: ReadonlyArray<WorktreeInfo>
  readonly onSelect: (cwd: string) => void
}

/** Selects the worktree where a new floating terminal should start. */
export const WorktreeSelectorUi = ({
  currentPath,
  worktrees,
  onSelect,
}: WorktreeSelectorUiProps) => {
  const { exit } = useExit()
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(() => {
    const current = worktrees.findIndex((worktree) => worktree.path === currentPath)
    return current < 0 ? 0 : current
  })

  const visible = useMemo(() => {
    const normalized = query.toLowerCase()
    return worktrees.filter(
      (worktree) =>
        normalized === "" ||
        (worktree.branch ?? "").toLowerCase().includes(normalized) ||
        worktree.label.toLowerCase().includes(normalized) ||
        worktree.path.toLowerCase().includes(normalized),
    )
  }, [query, worktrees])
  const index = Math.min(cursor, Math.max(visible.length - 1, 0))
  const selected = visible[index]
  const windowStart = Math.min(Math.max(index - 3, 0), Math.max(visible.length - 10, 0))

  const move = useCallback(
    (delta: number) => {
      setCursor(() => {
        if (visible.length === 0) return 0
        const next = index + delta
        return next < 0 ? 0 : next >= visible.length ? visible.length - 1 : next
      })
    },
    [index, visible.length],
  )

  const modes = useMemo<Record<Mode, ModeSpec>>(
    () => ({
      select: {
        onText: (text) => {
          setQuery((value) => value + text)
          setCursor(0)
        },
        onBackspace: () => {
          setQuery((value) => value.slice(0, -1))
          setCursor(0)
        },
        bindings: {
          j: { description: "down", run: () => move(1) },
          k: { description: "up", run: () => move(-1) },
          down: { description: "down", run: () => move(1), hidden: true },
          up: { description: "up", run: () => move(-1), hidden: true },
          return: {
            description: "open terminal",
            run: () => {
              if (selected === undefined) return
              onSelect(selected.path)
              exit()
            },
          },
          "ctrl+u": { description: "clear", run: () => setQuery("") },
          escape: { description: "quit", run: exit },
        },
      },
    }),
    [exit, move, onSelect, selected],
  )
  const modal = useModal<Mode>({ initial: "select", modes })

  return (
    <box style={{ flexDirection: "column", padding: 1, backgroundColor: theme.base }}>
      <text style={{ fg: theme.mauve }}>open terminal in worktree</text>
      <text style={{ fg: theme.text }}>{query === "" ? "type to filter" : query}</text>
      <box style={{ flexDirection: "column", paddingTop: 1 }}>
        {visible.length === 0 ? (
          <text style={{ fg: theme.overlay0 }}>no matching worktrees</text>
        ) : (
          visible.slice(windowStart, windowStart + 10).map((worktree, row) => (
            <text
              key={worktree.path}
              style={{ fg: row + windowStart === index ? theme.text : theme.subtext0 }}
            >
              {`${row + windowStart === index ? "▸ " : "  "}${worktree.branch ?? worktree.label}${worktree.path === currentPath ? "  (current)" : ""}`}
            </text>
          ))
        )}
      </box>
      <text style={{ fg: theme.overlay0, paddingTop: 1 }}>
        {modal.hints.map(([spec, description]) => `${spec} ${description}`).join("   ")}
      </text>
    </box>
  )
}
