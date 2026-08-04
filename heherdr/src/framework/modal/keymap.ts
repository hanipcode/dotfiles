/**
 * Modal keymap primitives — the vim-like core every heherdr plugin shares.
 *
 * A plugin declares one `ModeSpec` per mode ("normal", "filter", "confirm", …)
 * and the framework runs the state machine: key normalisation, multi-key
 * sequence matching with a pending buffer, and text capture for insert-like
 * modes. Pure and synchronous on purpose — it is trivially unit-testable and
 * carries no OpenTUI or Effect dependency.
 */

import type { KeyEvent } from "@opentui/core"

/**
 * Canonical form of a keypress, e.g. `j`, `escape`, `ctrl+d`, `shift+g`.
 *
 * Modifier order is fixed (ctrl, alt, shift, super) so specs compare as strings.
 * `shift+` is only emitted for keys whose name is not already shifted: `G`
 * arrives from the terminal as name `G`, so it normalises to `G`, not `shift+g`.
 */
export type KeyId = string

/**
 * A binding trigger: either a single {@link KeyId} (`"j"`) or a space-separated
 * sequence (`"g g"`, `"d d"`, `"space f"`) matched progressively like vim.
 */
export type KeySpec = string

export interface Binding {
  /** Shown in help / footer hints. */
  readonly description: string
  /** Runs when the spec matches. */
  readonly run: () => void
  /** Omit from generated footer hints. */
  readonly hidden?: boolean
}

export interface ModeSpec {
  /**
   * Printable keys not claimed by a binding are delivered here instead of being
   * dropped. Presence of this handler is what makes a mode "insert-like".
   */
  readonly onText?: (char: string) => void
  /** Backspace in a text-capturing mode. */
  readonly onBackspace?: () => void
  readonly bindings: Readonly<Record<KeySpec, Binding>>
}

/** Keys that must never be treated as text input. */
const NON_TEXT_KEYS = new Set([
  "escape",
  "return",
  "enter",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
])

/**
 * Normalise a raw OpenTUI key event into a {@link KeyId}.
 *
 * `option` is OpenTUI's macOS-aware alias for meta/alt; both are folded into
 * `alt+` so specs stay portable.
 */
export const keyId = (key: KeyEvent): KeyId => {
  const parts: Array<string> = []
  if (key.ctrl) parts.push("ctrl")
  if (key.meta || key.option) parts.push("alt")
  if (key.super) parts.push("super")

  const name = key.name || key.sequence

  // Only add shift when the name did not already encode it (`G` vs `shift+g`).
  // Without this check `G` would normalise to both `G` and `shift+G`.
  if (key.shift && name.length > 1) parts.push("shift")

  parts.push(name)
  return parts.join("+")
}

/**
 * True when the event should be appended to a text buffer: a bare printable
 * character, no modifiers beyond shift.
 */
export const isTextInput = (key: KeyEvent): boolean => {
  if (key.ctrl || key.meta || key.option || key.super) return false
  if (NON_TEXT_KEYS.has(key.name)) return false
  return key.sequence.length === 1 && key.sequence >= " " && key.sequence !== ""
}

const specSteps = (spec: KeySpec): ReadonlyArray<KeyId> => spec.trim().split(/\s+/)

export interface DispatchState {
  /** Keys accumulated toward a multi-key sequence; empty when idle. */
  readonly pending: ReadonlyArray<KeyId>
}

export const initialDispatchState: DispatchState = { pending: [] }

export type DispatchOutcome =
  /** A binding ran; pending was cleared. */
  | { readonly _tag: "ran"; readonly spec: KeySpec; readonly state: DispatchState }
  /** A prefix of one or more sequences matched; waiting for the next key. */
  | { readonly _tag: "pending"; readonly state: DispatchState }
  /** Delivered to `onText`. */
  | { readonly _tag: "text"; readonly char: string; readonly state: DispatchState }
  /** Nothing matched; pending was reset. */
  | { readonly _tag: "unhandled"; readonly state: DispatchState }

/**
 * Feed one key event through a mode.
 *
 * Resolution order matters: an exact match wins over a longer sequence still in
 * progress, so `d` bound alone and `d d` bound together means `d` fires
 * immediately and `d d` is unreachable. Bind `d` as a sequence prefix only.
 */
export const dispatch = (
  mode: ModeSpec,
  state: DispatchState,
  key: KeyEvent,
): DispatchOutcome => {
  const id = keyId(key)
  const attempt = [...state.pending, id]

  for (const [spec, binding] of Object.entries(mode.bindings)) {
    const steps = specSteps(spec)
    if (steps.length !== attempt.length) continue
    if (steps.every((step, i) => step === attempt[i])) {
      binding.run()
      return { _tag: "ran", spec, state: initialDispatchState }
    }
  }

  const hasLongerMatch = Object.keys(mode.bindings).some((spec) => {
    const steps = specSteps(spec)
    return steps.length > attempt.length && attempt.every((k, i) => steps[i] === k)
  })
  if (hasLongerMatch) return { _tag: "pending", state: { pending: attempt } }

  // Only treat as text when no sequence is mid-flight — otherwise typing `g`
  // then a non-matching key would leak `g` into a filter box.
  if (state.pending.length === 0 && mode.onText && isTextInput(key)) {
    mode.onText(key.sequence)
    return { _tag: "text", char: key.sequence, state: initialDispatchState }
  }

  if (state.pending.length === 0 && mode.onBackspace && key.name === "backspace") {
    mode.onBackspace()
    return { _tag: "ran", spec: "backspace", state: initialDispatchState }
  }

  return { _tag: "unhandled", state: initialDispatchState }
}

/** Footer hints for a mode: `[["j/k", "move"], ["/", "filter"]]`. */
export const hints = (mode: ModeSpec): ReadonlyArray<readonly [KeySpec, string]> =>
  Object.entries(mode.bindings)
    .filter(([, b]) => !b.hidden)
    .map(([spec, b]) => [spec, b.description] as const)
