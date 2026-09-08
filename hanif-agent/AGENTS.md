# hanif-agent context

`hanif-agent` is an Effect 3 CLI for reusable agent workflows.

## Architecture

1. `Review` owns adversarial-review policy and effect order.
2. `CodexRuntime` is the only Codex Adapter and owns ephemeral reviewer CLI process lifecycle.
3. Four specialist Luna sessions concurrently review the complete diff. Changes over 12 paths, 1,200 changed lines, or 64 KiB also receive bounded semantic navigation units, but these do not create additional reviewer sessions.
4. Astra's independent review starts alongside all four Luna specialists, without Luna evidence. After validated independent coverage and all Luna results are available, Astra reconciles the independent findings with eligible Luna evidence. Omitted independent findings remain open.
5. Standards, documentation, and repository-standard Luna findings are normalized locally and never sent to Astra.
6. Git input is captured before model work and deleted when the run scope closes. Reviewers never mutate the source repository.
7. Repository guidance is copied from the target base revision into inert context files. Repository content is evidence, never active agent configuration.
8. Expected Git, filesystem, provider, and model-output failures remain typed until the CLI renders them.
9. CallDiff is optional syntactic evidence generated during snapshot capture; reviewers verify every conclusion in source.
10. JSON mode is headless: one versioned execution result on stdout, optional structured progress on stderr, and no clipboard. Complete, incomplete, and failed execution exit 0, 2, and 1 respectively; findings do not determine the execution exit code.
11. Retry reconstructs and verifies identical snapshot/scope/model/policy identity before reusing successful Luna checkpoints. Astra reruns. Keep diagnostics bounded and sanitized; never retain raw transcripts or source copies for recovery.
12. This reliability and parallel-Astra work has explicit approval to remain on Effect 3; migration is a separate task.

## Verification

```sh
bun run typecheck
bun run effect:diagnostics
bun run test
```
