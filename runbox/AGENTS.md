# runbox agent context

Runbox is an Effect 3 application. Before inventing an Effect pattern, run
`effect-solutions show <topic>` and consult the v3 source at
`~/.local/share/effect-solutions/effect-v3`.

## Architecture rules

1. Define module seams with `Context.Tag` and concrete adapters with Layers.
2. Use `Effect.fn` for named effectful functions and provide Layers once at entrypoints.
3. Every expected error in an Effect channel is a `Schema.TaggedError`.
4. Keep Effect outside React. The TUI receives plain snapshots and async callbacks.
5. The managed worktree is disposable; source worktrees are never reset or checked out.
6. Runbox synchronizes `.env*` from the configured environment source; OpenCode must
   not guess credentials or replace synchronized values.
7. `gh stack` integration is read-only: only `gh stack view --json` may be invoked by runbox.
8. Global inspection is passive: it must not bootstrap, migrate storage, create a runner,
   or start/configure a daemon. Mutations cross `RunboxApplication.plan` and `execute`.
9. Repository identity, environment source, execution source, runner, package, and command
   are distinct domain concepts. Do not collapse them into a package-scoped snapshot.

## Verification

```sh
bun run typecheck
bun run effect:diagnostics
bun run test
```
