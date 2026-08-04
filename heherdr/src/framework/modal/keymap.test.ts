/**
 * The modal core is pure, so the vim semantics that are painful to verify by
 * hand in a terminal — sequence matching, prefix pending, text capture — get
 * tested here instead.
 */

import { describe, expect, it } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { dispatch, initialDispatchState, isTextInput, keyId, type ModeSpec } from "./keymap.ts"

const key = (over: Partial<KeyEvent> & { name: string }): KeyEvent =>
  ({
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: over.name,
    number: false,
    raw: over.name,
    eventType: "press",
    source: "kitty",
    ...over,
  }) as KeyEvent

describe("keyId", () => {
  it("normalises a bare key", () => {
    expect(keyId(key({ name: "j" }))).toBe("j")
  })

  it("prefixes modifiers in a fixed order", () => {
    expect(keyId(key({ name: "d", ctrl: true }))).toBe("ctrl+d")
    expect(keyId(key({ name: "u", ctrl: true, option: true }))).toBe("ctrl+alt+u")
  })

  it("does not double-encode an already-shifted name", () => {
    // `G` arrives as name "G"; emitting "shift+G" would make specs ambiguous.
    expect(keyId(key({ name: "G", shift: true }))).toBe("G")
  })

  it("folds option into alt so specs are portable", () => {
    expect(keyId(key({ name: "f", option: true }))).toBe("alt+f")
    expect(keyId(key({ name: "f", meta: true }))).toBe("alt+f")
  })
})

describe("isTextInput", () => {
  it("accepts printable characters", () => {
    expect(isTextInput(key({ name: "a" }))).toBe(true)
    expect(isTextInput(key({ name: "/", sequence: "/" }))).toBe(true)
  })

  it("rejects modified and named keys", () => {
    expect(isTextInput(key({ name: "a", ctrl: true }))).toBe(false)
    expect(isTextInput(key({ name: "escape", sequence: "\x1b" }))).toBe(false)
    expect(isTextInput(key({ name: "backspace", sequence: "\x7f" }))).toBe(false)
  })
})

describe("dispatch", () => {
  const spy = () => {
    const calls: Array<string> = []
    return { calls, mark: (id: string) => () => void calls.push(id) }
  }

  it("runs a single-key binding", () => {
    const { calls, mark } = spy()
    const mode: ModeSpec = { bindings: { j: { description: "down", run: mark("j") } } }
    const out = dispatch(mode, initialDispatchState, key({ name: "j" }))
    expect(out._tag).toBe("ran")
    expect(calls).toEqual(["j"])
  })

  it("holds a sequence prefix pending, then fires", () => {
    const { calls, mark } = spy()
    const mode: ModeSpec = { bindings: { "g g": { description: "top", run: mark("gg") } } }

    const first = dispatch(mode, initialDispatchState, key({ name: "g" }))
    expect(first._tag).toBe("pending")
    expect(calls).toEqual([])

    const second = dispatch(mode, first.state, key({ name: "g" }))
    expect(second._tag).toBe("ran")
    expect(calls).toEqual(["gg"])
    expect(second.state.pending).toEqual([])
  })

  it("abandons a sequence when the second key does not match", () => {
    const { calls, mark } = spy()
    const mode: ModeSpec = { bindings: { "d d": { description: "remove", run: mark("dd") } } }

    const first = dispatch(mode, initialDispatchState, key({ name: "d" }))
    const second = dispatch(mode, first.state, key({ name: "x" }))
    expect(second._tag).toBe("unhandled")
    expect(calls).toEqual([])
    expect(second.state.pending).toEqual([])
  })

  it("captures printable keys as text in an insert-like mode", () => {
    const typed: Array<string> = []
    const mode: ModeSpec = { onText: (c) => void typed.push(c), bindings: {} }

    const out = dispatch(mode, initialDispatchState, key({ name: "a" }))
    expect(out._tag).toBe("text")
    expect(typed).toEqual(["a"])
  })

  it("prefers a binding over text capture", () => {
    const typed: Array<string> = []
    const { calls, mark } = spy()
    const mode: ModeSpec = {
      onText: (c) => void typed.push(c),
      bindings: { q: { description: "quit", run: mark("quit") } },
    }

    dispatch(mode, initialDispatchState, key({ name: "q" }))
    expect(calls).toEqual(["quit"])
    expect(typed).toEqual([])
  })

  it("does not leak a pending sequence key into text capture", () => {
    // Regression guard: typing `g` then `x` in a mode that has both `g g` and
    // text capture must not append `g` to the buffer.
    const typed: Array<string> = []
    const mode: ModeSpec = {
      onText: (c) => void typed.push(c),
      bindings: { "g g": { description: "top", run: () => {} } },
    }

    const first = dispatch(mode, initialDispatchState, key({ name: "g" }))
    dispatch(mode, first.state, key({ name: "x" }))
    expect(typed).toEqual([])
  })

  it("routes backspace to onBackspace", () => {
    let deletions = 0
    const mode: ModeSpec = {
      onText: () => {},
      onBackspace: () => void deletions++,
      bindings: {},
    }
    dispatch(mode, initialDispatchState, key({ name: "backspace", sequence: "\x7f" }))
    expect(deletions).toBe(1)
  })
})
