import { Effect } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ReviewRunError } from "../errors.ts"
import { captureReviewSnapshot, removeReviewSnapshot } from "./git-snapshot.ts"
import { detectEffectAtomUsage, trustedSkillsDigest } from "./prompts.ts"
import { parseCodexModel } from "./codex-runtime.ts"
import type { ReviewError } from "../errors.ts"
import type { ReviewRequest } from "./domain.ts"
import { randomUUID } from "node:crypto"

const exec = promisify(execFile)

/** Check local Codex capabilities, exact Git scope, and trusted skills without model calls. */
export function reviewPreflight(request: ReviewRequest): Effect.Effect<{
  readonly repositoryRoot: string
  readonly baseRef: string
  readonly changedPathCount: number
  readonly reviewerModel: string
  readonly coordinatorModel: string
  readonly providerAccess: "not-tested"
}, ReviewError> {
  return Effect.gen(function* () {
    yield* parseCodexModel("luna", request.models.reviewer)
    yield* parseCodexModel("astra", request.models.coordinator)
    const help = yield* Effect.tryPromise({
      try: () => exec(process.env.HANIF_AGENT_CODEX_BIN ?? "codex", ["exec", "--help"], { timeout: 10_000 }),
      catch: () => new ReviewRunError({ operation: "review preflight", message: "Codex executable is unavailable or its help command failed" }),
    })
    const required = ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "--json", "--model"]
    const missing = required.filter((flag) => !help.stdout.includes(flag))
    if (missing.length > 0) return yield* new ReviewRunError({ operation: "review preflight",
      message: `Codex lacks required flags: ${missing.join(", ")}` })
    return yield* Effect.acquireUseRelease(
      captureReviewSnapshot(request.cwd, request.baseRef, randomUUID(), request.targetRef),
      (snapshot) => Effect.gen(function* () {
        const usesAtom = yield* detectEffectAtomUsage(snapshot.snapshotDirectory)
        yield* trustedSkillsDigest(snapshot.runtimeDirectory, usesAtom)
        return { repositoryRoot: snapshot.repositoryRoot, baseRef: snapshot.baseRef,
          changedPathCount: snapshot.changedPaths.length, reviewerModel: request.models.reviewer,
          coordinatorModel: request.models.coordinator, providerAccess: "not-tested" as const }
      }),
      (snapshot) => removeReviewSnapshot(snapshot).pipe(Effect.ignore),
    )
  })
}
