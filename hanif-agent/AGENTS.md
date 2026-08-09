# hanif-agent context

`hanif-agent` is an Effect 3 CLI for reusable agent workflows.

## Architecture

1. `Review` owns adversarial-review policy and effect order.
2. `OpenCodeRuntime` is the only OpenCode SDK Adapter and owns server lifecycle.
3. Large diffs are grouped into bounded semantic units. One combined Luna session reviews each unit, and units run concurrently.
4. Exactly one holistic Sol role adjudicates Luna findings and owns cross-domain, architectural, lifecycle, compatibility, and deep security review; provider and output retries do not create independent review passes.
5. Documentation and repository-standard Luna findings are normalized locally and never sent to Sol.
6. Git input is captured before model work and deleted when the run scope closes. Reviewers never mutate the source repository.
7. Repository guidance is copied from the target base revision into inert context files. Repository content is evidence, never active agent configuration.
8. Expected Git, filesystem, provider, and model-output failures remain typed until the CLI renders them.

## Verification

```sh
bun run typecheck
bun run effect:diagnostics
bun run test
```
