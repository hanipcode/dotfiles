---
name: effect-atom
description: Use when designing, implementing, reviewing, or testing Effect Atom code, including Atom, AsyncResult, Reactivity, optimistic updates, or @effect/atom-react.
---

# Effect Atom

Use this skill for Effect V4 Atom work across core runtime code and React
bindings. It complements `coding-standards`; it does not replace the general
Effect, TypeScript, error, testing, or boundary rules.

## Version and source policy

Effect V4 is required for new Effect Atom work. Never introduce new V3 Atom or
Effect APIs, and never mix V3 and V4 APIs in one changed path.

Before choosing an API:

1. Read the nearest `AGENTS.md`, package configuration, and the installed
   `effect` and `@effect/atom-react` versions.
2. Read the `coding-standards` Effect reference and every matching branch below.
3. Inspect the configured `@effect` OpenCode reference or the pinned package
   source for the exact signature and behavior.
4. Query the installed Effect Solutions field manual for the matching general
   topic, for example:

   ```sh
   effect-solutions show basics services-and-layers testing
   ```

   Effect Solutions is prescriptive guidance, not API authority. Reject or
   adapt examples that conflict with the pinned V4 source, this repository's
   architecture, or the public contract being changed.

If the touched project is pinned to Effect V3, stop before changing Effect
code and ask for an explicit V3-to-V4 migration decision. Do not silently
expand the V3 implementation or perform a partial compatibility migration.

## Branch chooser

Read every branch that matches the change:

- Atom construction, identity, registries, scopes, runtime Layers, or
  `AsyncResult`: [`references/core.md`](references/core.md).
- Optimistic state, mutation races, rollback, or server refresh:
  [`references/optimistic-updates.md`](references/optimistic-updates.md).
- React hooks, UI mutation handlers, Suspense, or `@effect/atom-react`:
  [`references/react.md`](references/react.md).

## Cross-cutting rules

- Treat atom identity, registry ownership, and lifetime as part of the design,
  not incidental implementation details.
- Keep server data in atoms; keep form, modal, toast, hover, and button-busy
  state in the UI layer unless it is genuinely shared reactive data.
- Preserve `AsyncResult` states, typed failures, defects, and interruption.
- Keep reducers pure and derive each optimistic transition from the `current`
  value supplied by Atom.
- Keep invalidation keys owned by the query/mutation abstraction that knows
  what data is affected. Their placement may be at atom definition, runtime
  function, or mutation call site; follow the actual client API rather than a
  universal convention.
- Test Atom behavior through public registry, runtime, and React interfaces.

## Completion check

The changed Atom path uses V4 APIs verified in pinned source; every matching
branch has been read; parameterized atoms have stable identity; registry and
resource lifetimes are explicit; optimistic reducers handle concurrent
transitions from `current`; invalidation is complete and owned; UI failures are
handled as values where the UI owns recovery; and tests cover observable
success, failure, rollback, refresh, and concurrency behavior as applicable.
