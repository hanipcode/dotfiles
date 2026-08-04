/**
 * React binding for the modal keymap — the hook every heherdr UI starts from.
 *
 * Mode state lives in an Atom so non-React code (Effect handlers, event
 * subscriptions) can read or drive it without prop-drilling.
 */

import { useKeyboard } from "@opentui/react"
import { useCallback, useMemo, useRef } from "react"
import { Atom, useAtomValue, useAtomSet } from "@effect-atom/atom-react"
import {
  dispatch,
  hints,
  initialDispatchState,
  type DispatchState,
  type KeySpec,
  type ModeSpec,
} from "./keymap.ts"

export interface ModalConfig<M extends string> {
  readonly initial: M
  /** One spec per mode. Built with `useMemo` by the caller to keep it stable. */
  readonly modes: Readonly<Record<M, ModeSpec>>
}

export interface Modal<M extends string> {
  readonly mode: M
  readonly setMode: (mode: M) => void
  /** Keys accumulated toward a sequence — render it as vim's bottom-right hint. */
  readonly pending: ReadonlyArray<string>
  readonly hints: ReadonlyArray<readonly [KeySpec, string]>
}

/**
 * Atom factory so each mounted UI gets isolated state. Exported for tests and
 * for plugins that want to read the current mode outside React.
 */
export const makeModeAtom = <M extends string>(initial: M) => Atom.make<M>(initial)

export const useModal = <M extends string>(config: ModalConfig<M>): Modal<M> => {
  // Atom identity must survive re-renders or every keypress would reset the mode.
  const modeAtom = useMemo(() => makeModeAtom(config.initial), [])
  const mode = useAtomValue(modeAtom)
  const setModeAtom = useAtomSet(modeAtom)

  // Pending sequence is a ref, not state: it changes on keys that must not
  // trigger a re-render on their own, and `pendingVersion` publishes it.
  const dispatchState = useRef<DispatchState>(initialDispatchState)
  const pendingAtom = useMemo(() => Atom.make<ReadonlyArray<string>>([]), [])
  const pending = useAtomValue(pendingAtom)
  const setPending = useAtomSet(pendingAtom)

  const setMode = useCallback(
    (next: M) => {
      // Switching modes always abandons a half-typed sequence, like vim.
      dispatchState.current = initialDispatchState
      setPending([])
      setModeAtom(next)
    },
    [setModeAtom, setPending],
  )

  const active = config.modes[mode]

  useKeyboard(
    useCallback(
      (key) => {
        const outcome = dispatch(active, dispatchState.current, key)
        dispatchState.current = outcome.state
        // Only publish when it actually changes, to avoid a render per keystroke.
        const next = outcome.state.pending
        setPending((prev) =>
          prev.length === next.length && prev.every((k, i) => k === next[i]) ? prev : next,
        )
      },
      [active, setPending],
    ),
  )

  return {
    mode,
    setMode,
    pending,
    hints: useMemo(() => hints(active), [active]),
  }
}
