# React Bindings

## Imports and atom identity

Effect V4 React bindings come from `@effect/atom-react`; core Atom modules come
from the V4 `effect` package:

```ts
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
```

Do not use the old `@effect-atom/atom-react` package or V3 `Result` examples in
new work. Verify the installed package export and version before editing.

React components should receive an atom with stable identity. A family call
with stable inputs is appropriate; constructing `Atom.optimistic(query(id))`
directly during render is not.

## Reading and writing

Use `useAtomValue` for reads and `useAtomSet` for writes. Read from the same
optimistic atom family that owns an optimistic mutation. Mounting and
subscription are handled by the React binding.

For asynchronous writable atoms, `useAtomSet(atom, { mode: "promiseExit" })`
returns a Promise of an `Exit`. Use that mode when the component owns the
failure branch:

```tsx
import * as Exit from "effect/Exit"
import { useAtomSet } from "@effect/atom-react"

const save = useAtomSet(saveAtom, { mode: "promiseExit" })

const onSave = async (input: SaveInput) => {
  const exit = await save(input)
  if (Exit.isFailure(exit)) {
    setError("Could not save changes")
    return
  }
  closeEditor()
}
```

Use `Exit.findErrorOption` and `Option` only when the UI has a truthful reason
to branch on a specific typed error. Preserve defects and interruption rather
than converting every cause into customer text.

`mode: "promise"` is appropriate only when the caller intentionally wants the
success value or deliberately lets the failure reach a boundary that handles
thrown failures. Do not wrap an Effect mutation in broad `try/catch` merely to
recover its typed failure; prefer `promiseExit` at a UI recovery boundary.

## AsyncResult rendering

Choose loading, stale-while-refreshing, success, and failure behavior
deliberately. `waiting` means newer work is active and may coexist with a
previous success; it is not necessarily a blank loading state.

```tsx
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

const content = AsyncResult.match(result, {
  onInitial: () => <Spinner />,
  onFailure: () => <ErrorState />,
  onSuccess: ({ value, waiting }) => (
    <List rows={value} refreshing={waiting} />
  )
})
```

If the component uses Suspense, verify whether the hook suspends on initial
state only or also on waiting state. Do not accidentally turn a refresh into a
full-page fallback.

## UI boundaries and errors

The component may translate a typed failure into user-facing copy, retry
affordances, or field errors. Keep classification on typed tags and fields;
do not inspect an unknown thrown value with `instanceof Error` or stringify it
for product behavior.

Keep network, persistence, schema decoding, and authorization errors in their
own services or adapters. Atom code should coordinate reactive state, not own a
second HTTP client or duplicate domain parsing.

## React tests

Test through the rendered component, React hooks, and a real in-memory atom
registry/runtime. Assert observable loading, stale refresh, success, failure,
optimistic, rollback, and retry behavior. Keep test controls in Layers or test
runtime setup rather than changing production atom tags.

Use `@effect/vitest` for Effect tests and the repository's established React
testing utilities for rendering. Avoid `vi.mock` and `jest.mock`; prefer a
faithful test Layer, deterministic mutation effect, and local boundary.
