/**
 * Worktree overlay.
 *
 * Layout is still provisional — the stable parts are the modal wiring and the
 * safety gate on removal. Deletion is behind a confirm mode on purpose: every
 * branch in a real repo tends to carry unmerged commits, and `git worktree
 * remove` silently refuses locked checkouts, so a single keystroke that
 * sometimes destroys work and sometimes no-ops is the wrong affordance.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useExit, useModal, theme, type ModeSpec } from "@heherdr/framework"
import type { WorktreeInfo, WorktreeList } from "@heherdr/framework/herdr/Client.ts"
import type { WorktreeSafety } from "@heherdr/framework/git/Client.ts"

type Mode = "normal" | "filter" | "confirm"

export interface RemoveOutcome {
  readonly ok: boolean
  readonly message: string
}

export interface WorktreeUiProps {
  readonly data: WorktreeList
  readonly onOpen: (worktree: WorktreeInfo) => void
  /** Merge/dirty/lock state, fetched lazily when the confirm gate opens. */
  readonly onInspect: (worktree: WorktreeInfo) => Promise<WorktreeSafety>
  readonly onRemove: (worktree: WorktreeInfo, force: boolean) => Promise<RemoveOutcome>
  readonly onRefresh: () => Promise<WorktreeList>
}

export const WorktreeUi = ({
  data,
  onOpen,
  onInspect,
  onRemove,
  onRefresh,
}: WorktreeUiProps) => {
  const { exit } = useExit()
  const [list, setList] = useState(data)
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [safety, setSafety] = useState<WorktreeSafety | null>(null)
  const [busy, setBusy] = useState(false)

  // useModal is called below, so bindings reach setMode through a ref.
  const setModeRef = useRef<(mode: Mode) => void>(() => {})

  const visible = useMemo(() => {
    const q = query.toLowerCase()
    return list.worktrees.filter(
      (w) =>
        q === "" ||
        (w.branch ?? "").toLowerCase().includes(q) ||
        w.path.toLowerCase().includes(q),
    )
  }, [list.worktrees, query])

  // Clamp rather than reset: filtering should keep you near where you were.
  const index = Math.min(cursor, Math.max(visible.length - 1, 0))
  const selected = visible[index]

  const move = useCallback(
    (delta: number) =>
      setCursor(() => {
        if (visible.length === 0) return 0
        const next = index + delta
        return next < 0 ? 0 : next >= visible.length ? visible.length - 1 : next
      }),
    [index, visible.length],
  )

  const refresh = useCallback(async () => {
    const next = await onRefresh()
    setList(next)
  }, [onRefresh])

  const beginRemove = useCallback(() => {
    if (!selected) return
    // The main checkout is not a removable worktree — refuse before confirming
    // rather than letting git produce a confusing error.
    if (!selected.is_linked_worktree) {
      setStatus("that is the main checkout, not a worktree")
      return
    }
    setSafety(null)
    setModeRef.current("confirm")
    void onInspect(selected).then(setSafety)
  }, [selected, onInspect])

  const performRemove = useCallback(
    (force: boolean) => {
      if (!selected || busy) return
      setBusy(true)
      void onRemove(selected, force)
        .then(async (outcome) => {
          setStatus(outcome.message)
          if (outcome.ok) await refresh()
        })
        .finally(() => {
          setBusy(false)
          setModeRef.current("normal")
        })
    },
    [selected, busy, onRemove, refresh],
  )

  const modes = useMemo<Record<Mode, ModeSpec>>(
    () => ({
      normal: {
        bindings: {
          j: { description: "down", run: () => move(1) },
          k: { description: "up", run: () => move(-1) },
          down: { description: "down", run: () => move(1), hidden: true },
          up: { description: "up", run: () => move(-1), hidden: true },
          "g g": { description: "top", run: () => setCursor(0) },
          G: { description: "bottom", run: () => setCursor(visible.length - 1) },
          "/": { description: "filter", run: () => setModeRef.current("filter") },
          return: {
            description: "open",
            run: () => {
              if (selected) {
                onOpen(selected)
                exit()
              }
            },
          },
          d: { description: "remove", run: beginRemove },
          r: { description: "reload", run: () => void refresh() },
          q: { description: "quit", run: exit },
          escape: { description: "quit", run: exit, hidden: true },
        },
      },

      filter: {
        onText: (char) => setQuery((q) => q + char),
        onBackspace: () => setQuery((q) => q.slice(0, -1)),
        bindings: {
          escape: { description: "cancel", run: () => setModeRef.current("normal") },
          return: { description: "accept", run: () => setModeRef.current("normal") },
          "ctrl+u": { description: "clear", run: () => setQuery("") },
        },
      },

      confirm: {
        bindings: {
          y: { description: "remove", run: () => performRemove(false) },
          // Locked checkouts and dirty trees need force; kept on a separate key
          // so it can never be the accidental one.
          Y: { description: "force remove", run: () => performRemove(true) },
          n: { description: "cancel", run: () => setModeRef.current("normal") },
          escape: { description: "cancel", run: () => setModeRef.current("normal"), hidden: true },
        },
      },
    }),
    // Handlers close over selection and list length, so specs must be rebuilt
    // when those change or bindings would act on stale rows.
    [move, visible.length, selected, exit, onOpen, beginRemove, performRemove, refresh],
  )

  const modal = useModal<Mode>({ initial: "normal", modes })
  setModeRef.current = modal.setMode

  return (
    <box style={{ flexDirection: "column", padding: 1, backgroundColor: theme.base }}>
      <text style={{ fg: theme.mauve }}>{`worktrees — ${list.source.repo_name}`}</text>

      <text style={{ fg: modal.mode === "filter" ? theme.text : theme.overlay0 }}>
        {query === "" && modal.mode !== "filter" ? "/ filter" : `/${query}`}
      </text>

      <box style={{ flexDirection: "column", paddingTop: 1 }}>
        {visible.length === 0 ? (
          <text style={{ fg: theme.overlay0 }}>no matching worktrees</text>
        ) : (
          visible.map((w, i) => (
            <text key={w.path} style={{ fg: i === index ? theme.text : theme.subtext0 }}>
              {`${i === index ? "▸ " : "  "}${w.branch ?? "(detached)"}${
                w.open_workspace_id ? "  ● open" : ""
              }${w.is_linked_worktree ? "" : "  (main)"}`}
            </text>
          ))
        )}
      </box>

      {modal.mode === "confirm" && selected ? (
        <box style={{ flexDirection: "column", paddingTop: 1 }}>
          <text style={{ fg: theme.red }}>{`remove ${selected.branch ?? selected.path}?`}</text>
          <text style={{ fg: theme.overlay1 }}>{selected.path}</text>
          {safety === null ? (
            <text style={{ fg: theme.overlay0 }}>checking…</text>
          ) : (
            <>
              {/*
                Danger is uncommitted work or commits that exist nowhere but here.
                An unmerged count is NOT danger — a worktree cut from a feature
                branch inherits that branch's commits, so it reads non-zero even
                with nothing of its own.
              */}
              <text
                style={{
                  fg:
                    safety.dirtyFiles > 0 || safety.pushedTo === null
                      ? theme.red
                      : safety.locked
                        ? theme.yellow
                        : theme.green,
                }}
              >
                {[
                  safety.dirtyFiles > 0 ? `${safety.dirtyFiles} uncommitted — WILL BE LOST` : null,
                  safety.pushedTo === null ? "not pushed anywhere — commits only exist here" : null,
                  safety.locked
                    ? `locked${safety.lockReason ? ` (${safety.lockReason})` : ""} — Y unlocks`
                    : null,
                ]
                  .filter((s) => s !== null)
                  .join("  ·  ") || "safe: clean, and commits are on a remote"}
              </text>
              <text style={{ fg: theme.overlay0 }}>
                {[
                  safety.pushedTo !== null ? `on ${safety.pushedTo}` : null,
                  safety.unmergedCommits > 0
                    ? `${safety.unmergedCommits} commits ahead of default branch (may be inherited)`
                    : null,
                ]
                  .filter((s) => s !== null)
                  .join("  ·  ")}
              </text>
            </>
          )}
        </box>
      ) : null}

      {status !== null ? (
        <text style={{ fg: theme.peach, paddingTop: 1 }}>{status}</text>
      ) : null}

      <text style={{ fg: theme.overlay0, paddingTop: 1 }}>
        {busy
          ? "working…"
          : modal.hints.map(([spec, desc]) => `${spec} ${desc}`).join("   ") +
            (modal.pending.length > 0 ? `   [${modal.pending.join(" ")}]` : "")}
      </text>
    </box>
  )
}
