# hanif-agent context

`hanif-agent` is an Effect 3 CLI for reusable agent workflows.

## Architecture

1. `Review` owns adversarial-review policy and effect order.
2. `OpenCodeRuntime` is the only OpenCode SDK Adapter and owns server lifecycle.
3. Reviewer roles are application data executed in isolated sessions. They are not OpenCode subagents.
4. Git input is captured before model work. Reviewers never mutate the source repository.
5. Expected Git, filesystem, provider, and model-output failures remain typed until the CLI renders them.

## Verification

```sh
bun run typecheck
bun run effect:diagnostics
bun run test
```
