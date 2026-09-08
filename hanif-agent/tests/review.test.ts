import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { ReviewModels, type ReviewerResponse, type ReviewProgressEvent } from "../src/review/domain.ts"
import { captureReviewSnapshot, removeReviewSnapshot } from "../src/review/git-snapshot.ts"
import { CodexRuntime } from "../src/review/codex-runtime.ts"
import { goalReferenceFromBranch } from "../src/review/prompts.ts"
import { Review } from "../src/review/review.ts"

const run = async (cwd: string, command: ReadonlyArray<string>): Promise<string> => {
  const [executable, ...args] = command
  if (executable === undefined) throw new Error("cannot run an empty command")
  const child = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? -1))
  })
  if (exitCode !== 0) throw new Error(`${command.join(" ")}: ${stderr}`)
  return stdout.trim()
}

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hanif-agent-test-"))
  await run(root, ["git", "init", "-b", "main"])
  await run(root, ["git", "config", "user.email", "test@example.com"])
  await run(root, ["git", "config", "user.name", "Test"])
  await mkdir(join(root, "docs", "playbook"), { recursive: true })
  await writeFile(join(root, "app.ts"), "export const value = 1\n")
  await writeFile(join(root, "CLAUDE.md"), "Review changes using AI-REVIEW.md.\n")
  await symlink("CLAUDE.md", join(root, "AGENTS.md"))
  await writeFile(join(root, "AI-REVIEW.md"), "Apply every rule in docs/playbook/.\n")
  await writeFile(join(root, "docs", "playbook", "rules.md"), "Accepted rule: use direct imports.\n")
  await run(root, ["git", "add", "."])
  await run(root, ["git", "commit", "-m", "initial"])
  await run(root, ["git", "switch", "-c", "feature/review"])
  return root
}

const assignedPaths = (prompt: string): ReadonlyArray<string> => {
  const match = /Assigned paths, all of which must appear in reviewedPaths:\n(\[[\s\S]*?\])\n\nCheck/.exec(prompt)
  if (match?.[1] === undefined) throw new Error("Luna prompt has no assigned path list")
  return JSON.parse(match[1]) as ReadonlyArray<string>
}

const astraPaths = (prompt: string): ReadonlyArray<string> => {
  const match = /Changed paths, all of which must appear in reviewedPaths:\n(\[[\s\S]*?\])\n\nReview metadata/.exec(prompt)
  if (match?.[1] === undefined) throw new Error("Astra prompt has no changed path list")
  return JSON.parse(match[1]) as ReadonlyArray<string>
}

const coordinatorJson = (prompt: string): string => JSON.stringify({
  summary: "clean",
  reviewedPaths: astraPaths(prompt),
  findings: [],
})

const lunaJson = (prompt: string, includeDirectFinding = false): string => JSON.stringify({
  summary: includeDirectFinding ? "Playbook violation marker" : "unit checked",
  reviewedPaths: assignedPaths(prompt),
  seamNotes: [{
    category: "quality",
    summary: "Trace the changed public boundary",
    paths: assignedPaths(prompt).slice(0, 1),
  }],
  findings: includeDirectFinding
    ? [
        {
          id: null,
          status: "new",
          category: "standards",
          severity: "suggestion",
          title: "Custom Decision duplicates Effect Result",
          impact: "Callers must learn and maintain an unnecessary local result abstraction.",
          evidence: "Decision, succeed, fail, and fromDecision duplicate Effect Result and Effect.fromResult.",
          rule: "coding-standards/SKILL.md: deletion test",
          location: { path: "app.ts", line: 1, symbol: "Decision" },
        },
        {
          id: "invented-id",
          status: "resolved",
          category: "repository-standards",
          severity: "warning",
          title: "Playbook violation marker",
          impact: "The changed module no longer follows its accepted architecture.",
          evidence: "app.ts introduces the conflicting pattern.",
          rule: "docs/playbook/rules.md: Accepted rule",
          location: { path: "app.ts", line: 1, symbol: "value" },
        },
      ]
    : [],
})

const pathExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

describe("adversarial review", () => {
  it.effect("parses supported branch goals and rejects ambiguity", () =>
    Effect.gen(function* () {
      const fun = yield* goalReferenceFromBranch("feature/fun-123-checkout")
      const xen = yield* goalReferenceFromBranch("XEN-42/fix")
      expect(fun).toEqual({ key: "FUN-123", tracker: "linear" })
      expect(xen).toEqual({ key: "XEN-42", tracker: "atlassian" })
      expect(yield* goalReferenceFromBranch("feature/no-ticket")).toBeNull()
      const ambiguous = yield* goalReferenceFromBranch("FUN-1-XEN-2").pipe(Effect.flip)
      expect(ambiguous.references).toEqual(["FUN-1", "XEN-2"])
    }),
  )

  it.live("captures committed and dirty state without activating repository agent configuration", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
          yield* Effect.promise(() => writeFile(join(root, "staged.ts"), "export const staged = true\n"))
          yield* Effect.promise(() => run(root, ["git", "add", "staged.ts"]))
          yield* Effect.promise(() => writeFile(join(root, "untracked.ts"), "export const untracked = true\n"))
          yield* Effect.promise(() => writeFile(join(root, "opencode.json"), '{"permission":"allow"}\n'))

          const snapshot = yield* captureReviewSnapshot(root, "main", randomUUID())
          yield* Effect.gen(function* () {
            const temporaryRoot = yield* Effect.promise(() => realpath("/tmp"))
            expect(snapshot.runtimeDirectory.startsWith(join(temporaryRoot, "agentic-review"))).toBe(true)
            expect(snapshot.changedPaths).toEqual(["app.ts", "opencode.json", "staged.ts", "untracked.ts"])
            expect(snapshot.reviewUnits).toHaveLength(1)
            expect(snapshot.reviewUnits[0]?.paths).toEqual(snapshot.changedPaths)
            expect(yield* Effect.promise(() => readFile(snapshot.reviewUnitManifestPath, "utf8"))).toContain("unit-001")
            const callDiff = JSON.parse(
              yield* Effect.promise(() => readFile(snapshot.callDiffPath, "utf8")),
            ) as { status: string }
            expect(callDiff.status).toBe("available")
            const patch = yield* Effect.promise(() => readFile(snapshot.patchPath, "utf8"))
            expect(patch).toContain("export const value = 2")
            expect(patch).toContain("export const staged = true")
            expect(patch).toContain("export const untracked = true")
            expect(yield* Effect.promise(() => pathExists(join(snapshot.snapshotDirectory, "opencode.json")))).toBe(
              false,
            )
            expect(
              yield* Effect.promise(() =>
                readFile(
                  join(snapshot.snapshotDirectory, ".hanif-agent", "untrusted-repository-control", "opencode.json.txt"),
                  "utf8",
                ),
              ),
            ).toContain("permission")
          }).pipe(Effect.ensuring(removeReviewSnapshot(snapshot).pipe(Effect.ignore)))
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("captures only staged, unstaged, and untracked changes against HEAD", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(root, "committed.ts"), "export const committed = true\n"))
          yield* Effect.promise(() => run(root, ["git", "add", "committed.ts"]))
          yield* Effect.promise(() => run(root, ["git", "commit", "-m", "branch change"]))
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
          yield* Effect.promise(() => writeFile(join(root, "staged.ts"), "export const staged = true\n"))
          yield* Effect.promise(() => run(root, ["git", "add", "staged.ts"]))
          yield* Effect.promise(() => writeFile(join(root, "untracked.ts"), "export const untracked = true\n"))

          const snapshot = yield* captureReviewSnapshot(root, "HEAD", randomUUID())
          yield* Effect.gen(function* () {
            expect(snapshot.baseRef).toBe("HEAD")
            expect(snapshot.mergeBase).toBe(snapshot.head)
            expect(snapshot.changedPaths).toEqual(["app.ts", "staged.ts", "untracked.ts"])
            const patch = yield* Effect.promise(() => readFile(snapshot.patchPath, "utf8"))
            expect(patch).toContain("export const value = 2")
            expect(patch).toContain("export const staged = true")
            expect(patch).toContain("export const untracked = true")
            expect(patch).not.toContain("export const committed = true")
          }).pipe(Effect.ensuring(removeReviewSnapshot(snapshot).pipe(Effect.ignore)))
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("captures the last commit without dirty worktree changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(root, "earlier.ts"), "export const earlier = true\n"))
          yield* Effect.promise(() => run(root, ["git", "add", "earlier.ts"]))
          yield* Effect.promise(() => run(root, ["git", "commit", "-m", "earlier change"]))
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
          yield* Effect.promise(() => writeFile(join(root, "committed.ts"), "export const committed = true\n"))
          yield* Effect.promise(() => run(root, ["git", "add", "app.ts", "committed.ts"]))
          yield* Effect.promise(() => run(root, ["git", "commit", "-m", "last commit"]))
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 999\n"))
          yield* Effect.promise(() => writeFile(join(root, "staged.ts"), "export const staged = true\n"))
          yield* Effect.promise(() => run(root, ["git", "add", "staged.ts"]))
          yield* Effect.promise(() => writeFile(join(root, "untracked.ts"), "export const untracked = true\n"))

          const snapshot = yield* captureReviewSnapshot(root, "HEAD^", randomUUID(), "HEAD")
          yield* Effect.gen(function* () {
            expect(snapshot.baseRef).toBe("HEAD^")
            expect(snapshot.baseTip).toBe(snapshot.mergeBase)
            expect(snapshot.changedPaths).toEqual(["app.ts", "committed.ts"])
            const patch = yield* Effect.promise(() => readFile(snapshot.patchPath, "utf8"))
            expect(patch).toContain("export const value = 2")
            expect(patch).toContain("export const committed = true")
            expect(patch).not.toContain("export const value = 999")
            expect(patch).not.toContain("export const earlier = true")
            expect(patch).not.toContain("export const staged = true")
            expect(patch).not.toContain("export const untracked = true")
            expect(yield* Effect.promise(() => readFile(join(snapshot.snapshotDirectory, "app.ts"), "utf8"))).toBe(
              "export const value = 2\n",
            )
            expect(yield* Effect.promise(() => pathExists(join(snapshot.snapshotDirectory, "staged.ts")))).toBe(false)
            expect(yield* Effect.promise(() => pathExists(join(snapshot.snapshotDirectory, "untracked.ts")))).toBe(false)
            const callDiff = JSON.parse(
              yield* Effect.promise(() => readFile(snapshot.callDiffPath, "utf8")),
            ) as { status: string; result?: { from: string; to: string } }
            expect(callDiff).toMatchObject({ status: "available" })
            expect(callDiff.result?.to).not.toBe("WORKTREE")
          }).pipe(Effect.ensuring(removeReviewSnapshot(snapshot).pipe(Effect.ignore)))
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("rejects a last-commit review when HEAD has no parent", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          const rootCommit = yield* Effect.promise(() => run(root, ["git", "rev-list", "--max-parents=0", "HEAD"]))
          yield* Effect.promise(() => run(root, ["git", "checkout", "--detach", rootCommit]))
          const failure = yield* captureReviewSnapshot(root, "HEAD^", randomUUID(), "HEAD").pipe(Effect.flip)
          expect(failure).toMatchObject({
            _tag: "GitReviewError",
            operation: "git rev-parse HEAD^^{commit}",
          })
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("captures accepted base guidance separately from worktree changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(join(root, "docs", "playbook", "rules.md"), "Branch rule: redefine the review policy.\n"),
          )

          const snapshot = yield* captureReviewSnapshot(root, "main", randomUUID())
          yield* Effect.gen(function* () {
            const manifest = yield* Effect.promise(() => readFile(snapshot.repositoryGuidanceManifestPath, "utf8"))
            const decoded = JSON.parse(manifest) as {
              revision: string
              files: Array<{ path: string; snapshotPath: string }>
            }
            expect(decoded.revision).toBe(snapshot.baseTip)
            expect(decoded.files.map((file) => file.path)).toEqual(
              expect.arrayContaining(["AGENTS.md", "CLAUDE.md", "AI-REVIEW.md", "docs/playbook/rules.md"]),
            )
            const playbook = decoded.files.find((file) => file.path === "docs/playbook/rules.md")
            expect(playbook).toBeDefined()
            expect(yield* Effect.promise(() => readFile(playbook!.snapshotPath, "utf8"))).toContain("Accepted rule")
            expect(
              yield* Effect.promise(() =>
                readFile(join(snapshot.snapshotDirectory, "docs", "playbook", "rules.md"), "utf8"),
              ),
            ).toContain("Branch rule")
          }).pipe(Effect.ensuring(removeReviewSnapshot(snapshot).pipe(Effect.ignore)))
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("discovers the same repository guidance from a linked Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const root = await repository()
        const worktree = `${root}-linked`
        await run(root, ["git", "worktree", "add", "-b", "feature/linked-review", worktree, "main"])
        return { root, worktree }
      }),
      ({ worktree }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(worktree, "app.ts"), "export const value = 2\n"))
          const snapshot = yield* captureReviewSnapshot(worktree, "main", randomUUID())
          yield* Effect.gen(function* () {
            const manifest = JSON.parse(
              yield* Effect.promise(() => readFile(snapshot.repositoryGuidanceManifestPath, "utf8")),
            ) as { files: Array<{ path: string }> }
            expect(snapshot.repositoryRoot).toMatch(/-linked$/)
            expect(manifest.files.map((file) => file.path)).toEqual(
              expect.arrayContaining(["AGENTS.md", "AI-REVIEW.md", "docs/playbook/rules.md"]),
            )
          }).pipe(Effect.ensuring(removeReviewSnapshot(snapshot).pipe(Effect.ignore)))
        }),
      ({ root, worktree }) =>
        Effect.promise(async () => {
          await run(root, ["git", "worktree", "remove", "--force", worktree]).catch(() => undefined)
          await rm(root, { recursive: true, force: true })
          await rm(worktree, { recursive: true, force: true })
        }),
    ),
  )

  it.live("runs Luna alongside independent Astra, reconciles afterward, and reuses an unchanged result", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
          yield* Effect.promise(() => mkdir(join(root, "packages", "alpha", "src"), { recursive: true }))
          yield* Effect.promise(() => mkdir(join(root, "packages", "beta", "src"), { recursive: true }))
          const largeChange = (prefix: string) => Array.from(
            { length: 2_100 },
            (_, index) => `export const ${prefix}${index} = "${"x".repeat(48)}"`,
          ).join("\n")
          yield* Effect.promise(() => writeFile(join(root, "packages", "alpha", "src", "alpha.ts"), largeChange("a")))
          yield* Effect.promise(() => writeFile(join(root, "packages", "beta", "src", "beta.ts"), largeChange("b")))
          const roles: Array<string> = []
          const progress: Array<ReviewProgressEvent> = []
          const prompts = new Map<string, string>()
          let reactSkill = ""
          let active = 0
          let maximumActive = 0
          const fakeRuntime = Layer.succeed(
            CodexRuntime,
            CodexRuntime.of({
              start: ({ directory }) =>
                Effect.sync(() => {
                  let usage = {
                    costUsd: 0,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  }
                  return {
                    usage: Effect.sync(() => usage),
                    run: (task) =>
                      Effect.gen(function* () {
                        roles.push(task.role)
                        prompts.set(task.role, task.prompt)
                        if (task.role.startsWith("luna-") && reactSkill.length === 0) {
                          reactSkill = yield* Effect.promise(() =>
                            readFile(join(directory, "context", "vercel-react-best-practices", "SKILL.md"), "utf8"),
                          )
                        }
                        active += 1
                        maximumActive = Math.max(maximumActive, active)
                        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))
                        active -= 1
                        usage = {
                          costUsd: usage.costUsd + 0.25,
                          inputTokens: usage.inputTokens + 100,
                          cacheReadTokens: usage.cacheReadTokens + 300,
                          cacheWriteTokens: usage.cacheWriteTokens + 100,
                        }
                        const response: ReviewerResponse = {
                          role: task.role,
                          sessionId: randomUUID(),
                          text: task.role.startsWith("astra-")
                            ? coordinatorJson(task.prompt)
                            : lunaJson(
                                task.prompt,
                                task.role.endsWith("-standards-modules") && assignedPaths(task.prompt).includes("app.ts"),
                              ),
                        }
                        return response
                      }),
                  }
                }),
            }),
          )
          const layer = Review.layerWithoutDependencies.pipe(Layer.provide(fakeRuntime))
          const request = {
            cwd: root,
            baseRef: "main",
            models: ReviewModels.make({
              reviewer: "openai/gpt-5.6-luna#high",
              coordinator: "openai/gpt-6-astra#high",
            }),
            onProgress: (event: ReviewProgressEvent) => Effect.sync(() => void progress.push(event)),
          }

          const first = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run(request)
          }).pipe(Effect.provide(layer))
          expect(first.complete).toBe(true)
          expect(first.mode).toBe("full")
          expect(first.costUsd).toBe(1.5)
          expect(first.cachedInputPercent).toBe(60)
          expect(first.summary).toContain("2 Luna-final findings remain active")
          expect(reactSkill).toContain("Vercel React Best Practices")
          expect(yield* Effect.promise(() => pathExists(join(dirname(first.historyPath), "runs", first.runId)))).toBe(
            false,
          )
          const directFinding = first.findings.find((finding) => finding.title === "Playbook violation marker")
          expect(directFinding).toMatchObject({
            id: expect.any(String),
            status: "new",
            category: "repository-standards",
            sources: [expect.stringMatching(/^luna-/)],
          })
          expect(first.findings.find((finding) => finding.title === "Custom Decision duplicates Effect Result")).toMatchObject({
            status: "new",
            category: "standards",
            sources: [expect.stringMatching(/standards-modules$/)],
          })
          expect(maximumActive).toBeGreaterThan(1)
          expect(roles.at(-1)).toBe("astra-reconcile")
          expect(roles.filter((role) => role === "astra-independent")).toHaveLength(1)
          expect(roles.filter((role) => role.startsWith("luna-"))).toHaveLength(4)
          expect(roles.filter((role) => role === "luna-security")).toHaveLength(1)
          expect(roles.filter((role) => role === "luna-standards-contracts")).toHaveLength(1)
          expect(roles.filter((role) => role === "luna-standards-modules")).toHaveLength(1)
          expect(roles.filter((role) => role === "luna-quality")).toHaveLength(1)
          expect([...prompts.values()].filter((prompt) => prompt.includes("Assigned paths"))).toSatisfy(
            (values: ReadonlyArray<string>) => values.every((prompt) => assignedPaths(prompt).length === 3),
          )
          const modulesPrompt = [...prompts].find(([role]) => role.endsWith("-standards-modules"))?.[1]
          const securityPrompt = [...prompts].find(([role]) => role.endsWith("-security"))?.[1]
          expect(modulesPrompt).toContain("repository-guidance.json")
           expect(modulesPrompt).toContain("custom Result")
           for (const role of ["luna-standards-contracts", "luna-standards-modules"]) {
             const prompt = prompts.get(role)
             expect(prompt).toContain("## effect-slopcop")
             expect(prompt).toContain("only to Effect projects")
             expect(prompt).toContain("effect-slopcop/<number>")
             for (let rule = 1; rule <= 19; rule += 1) {
               expect(prompt).toContain(`\n${rule}. `)
             }
             expect(prompt).toContain("never at operation call sites")
             expect(prompt).toContain("Reviewers remain read-only")
           }
           for (const role of ["luna-security", "luna-quality", "astra-independent", "astra-reconcile"]) {
             expect(prompts.get(role)).not.toContain("## effect-slopcop")
           }
           expect(securityPrompt).not.toContain("coding-standards/SKILL.md")
          expect(prompts.get("astra-reconcile")).not.toContain("Playbook violation marker")
          expect(prompts.get("astra-reconcile")).toContain("Trace the changed public boundary")
          expect(prompts.get("astra-independent")).toContain("Review every changed path yourself")
          expect(prompts.get("astra-independent")).not.toContain("Luna local evidence")
          expect(progress.some((event) => event.type === "snapshot_ready" && event.unitCount === 7)).toBe(true)
          expect(progress.some((event) => event.type === "stage_started" && event.role === "astra-reconcile")).toBe(true)
          expect(progress.some((event) => event.type === "review_finished" && event.complete)).toBe(true)

          const callsAfterFirstReview = roles.length
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 3\n"))
          const second = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run(request)
          }).pipe(Effect.provide(layer))
          expect(second.mode).toBe("full")
          expect(second.costUsd).toBe(1.5)
          expect(second.cachedInputPercent).toBe(60)
          expect(yield* Effect.promise(() => pathExists(join(dirname(second.historyPath), "runs", second.runId)))).toBe(
            false,
          )
          expect(second.findings.find((finding) => finding.title === "Playbook violation marker")).toMatchObject({
            id: directFinding?.id,
            status: "open",
          })
          expect(prompts.get("astra-reconcile")).not.toContain("Playbook violation marker")
          expect(roles).toHaveLength(callsAfterFirstReview + 6)

          const callsAfterSecondReview = roles.length
          const third = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run(request)
          }).pipe(Effect.provide(layer))
          expect(third.mode).toBe("cache_hit")
          expect(third.costUsd).toBe(0)
          expect(third.cachedInputPercent).toBeNull()
          expect(roles).toHaveLength(callsAfterSecondReview)
          expect(yield* Effect.promise(() => pathExists(join(dirname(third.historyPath), "runs", third.runId)))).toBe(
            false,
          )

          const changedModels = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run({
              ...request,
              models: ReviewModels.make({
                reviewer: "openai/gpt-5.6-luna-fast#high",
                coordinator: "openai/gpt-6-astra#high",
              }),
            })
          }).pipe(Effect.provide(layer))
          expect(changedModels.mode).toBe("full")
          expect(roles).toHaveLength(callsAfterSecondReview + 6)
          const history = yield* Effect.promise(() => readFile(third.historyPath, "utf8"))
          expect(history).toContain('"type":"run_finished"')
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("does not cache a review when a Luna specialist fails its coverage contract", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
          const roles: Array<string> = []
          let astraPrompt = ""
          const fakeRuntime = Layer.succeed(
            CodexRuntime,
            CodexRuntime.of({
              start: () =>
                Effect.succeed({
                  usage: Effect.succeed({
                    costUsd: 0,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  }),
                  run: (task) =>
                    Effect.sync(() => {
                       roles.push(task.role)
                       if (task.role === "astra-reconcile") astraPrompt = task.prompt
                        return {
                          role: task.role,
                          sessionId: randomUUID(),
                          text: task.role.startsWith("astra-")
                            ? coordinatorJson(task.prompt)
                            : JSON.stringify({
                                summary: "incomplete coverage",
                                reviewedPaths: [],
                                seamNotes: [],
                                findings: [],
                              }),
                      }
                    }),
                }),
            }),
          )
          const layer = Review.layerWithoutDependencies.pipe(Layer.provide(fakeRuntime))
          const request = {
            cwd: root,
            baseRef: "main",
            models: ReviewModels.make({
              reviewer: "reviewer",
              coordinator: "coordinator",
            }),
          }

          const first = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run(request)
          }).pipe(Effect.provide(layer))
          expect(first.complete).toBe(false)
          expect(roles.filter((role) => role.startsWith("luna-"))).toHaveLength(8)
          expect(roles.filter((role) => role === "astra-reconcile")).toHaveLength(1)
          expect(astraPrompt).toContain("Luna specialist assignments without valid local evidence")
          expect(astraPrompt).toContain("complete-change")
          expect(yield* Effect.promise(() => pathExists(join(dirname(first.historyPath), "runs", first.runId)))).toBe(
            false,
          )

          const callsAfterFirst = roles.length
          const second = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run(request)
          }).pipe(Effect.provide(layer))
          expect(second.mode).toBe("full")
          expect(roles).toHaveLength(callsAfterFirst * 2)
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("rejects an Astra review that does not independently cover every changed path", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeFile(join(root, "app.ts"), "export const value = 2\n"))
          let astraCalls = 0
          const fakeRuntime = Layer.succeed(
            CodexRuntime,
            CodexRuntime.of({
              start: () =>
                Effect.succeed({
                  usage: Effect.succeed({
                    costUsd: 0,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  }),
                  run: (task) =>
                    Effect.sync(() => {
                      if (task.role === "astra-independent") astraCalls += 1
                      return {
                        role: task.role,
                        sessionId: randomUUID(),
                        text: task.role === "astra-independent"
                          ? JSON.stringify({ summary: "incomplete", reviewedPaths: [], findings: [] })
                          : lunaJson(task.prompt),
                      }
                    }),
                }),
            }),
          )
          const failure = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run({
              cwd: root,
              baseRef: "main",
              models: ReviewModels.make({ reviewer: "reviewer", coordinator: "coordinator" }),
            })
          }).pipe(
            Effect.provide(Review.layerWithoutDependencies.pipe(Layer.provide(fakeRuntime))),
            Effect.flip,
          )

          expect(failure).toMatchObject({
            _tag: "ReviewerOutputError",
            role: "astra-independent",
          })
          expect(astraCalls).toBe(2)
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  it.live("adds Effect Atom guidance to applicable complete-diff specialists", () =>
    Effect.acquireUseRelease(
      Effect.promise(repository),
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(
              join(root, "package.json"),
              JSON.stringify({
                dependencies: { "@effect/atom-react": "^0.1.0" },
              }),
            ),
          )
          yield* Effect.promise(() =>
            writeFile(
              join(root, "app.tsx"),
              'import { useAtomValue } from "@effect/atom-react"\nexport const value = useAtomValue\n',
            ),
          )
          const roles: Array<string> = []
          const prompts = new Map<string, string>()
          let effectAtomSkill = ""
          const fakeRuntime = Layer.succeed(
            CodexRuntime,
            CodexRuntime.of({
              start: ({ directory }) =>
                Effect.succeed({
                  usage: Effect.succeed({
                    costUsd: 0,
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  }),
                  run: (task) =>
                    Effect.gen(function* () {
                      roles.push(task.role)
                      prompts.set(task.role, task.prompt)
                        if (task.role.startsWith("luna-")) {
                          effectAtomSkill = yield* Effect.promise(() =>
                            readFile(join(directory, "context", "effect-atom", "SKILL.md"), "utf8"),
                        )
                      }
                      return {
                          role: task.role,
                          sessionId: randomUUID(),
                          text: task.role.startsWith("astra-") ? coordinatorJson(task.prompt) : lunaJson(task.prompt),
                      }
                    }),
                }),
            }),
          )
          const result = yield* Effect.gen(function* () {
            const review = yield* Review
            return yield* review.run({
              cwd: root,
              baseRef: "main",
              models: ReviewModels.make({
                reviewer: "reviewer",
                coordinator: "coordinator",
              }),
            })
          }).pipe(Effect.provide(Review.layerWithoutDependencies.pipe(Layer.provide(fakeRuntime))))

          expect(result.complete).toBe(true)
          expect(roles.filter((role) => role.startsWith("luna-"))).toHaveLength(4)
          const standardsPrompt = [...prompts].find(([role]) => role.endsWith("-standards-contracts"))?.[1]
          expect(standardsPrompt).toContain("effect-atom/SKILL.md")
          expect(effectAtomSkill).toContain("# Effect Atom")
          expect(yield* Effect.promise(() => pathExists(join(dirname(result.historyPath), "runs", result.runId)))).toBe(
            false,
          )
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )
})
