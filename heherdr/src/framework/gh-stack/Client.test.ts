import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  GhStackClient,
  decodeStackFile,
  layer,
  normalizeStacks,
  stacksForBranch,
} from "./Client.ts"

const file = (stack: Record<string, unknown>) =>
  decodeStackFile({ schemaVersion: 1, stacks: [stack] })

describe("gh-stack metadata", () => {
  it("decodes and normalizes schema version 1", () => {
    const stacks = normalizeStacks([
      file({
        id: "stack-id",
        number: 12,
        trunk: { branch: "main", head: "abc" },
        branches: [
          { branch: "auth", base: "abc" },
          {
            branch: "api",
            base: "def",
            pullRequest: { number: 42, url: "https://example.test/pr/42", merged: true },
          },
        ],
      }),
    ])

    expect(stacks).toEqual([
      {
        id: "stack-id",
        number: 12,
        trunk: "main",
        branches: [
          { branch: "auth", pullRequest: null },
          {
            branch: "api",
            pullRequest: { number: 42, url: "https://example.test/pr/42", merged: true },
          },
        ],
      },
    ])
  })

  it("rejects unsupported schema versions", () => {
    expect(() => decodeStackFile({ schemaVersion: 2, stacks: [] })).toThrow()
  })

  it("deduplicates the same stack discovered through multiple worktrees", () => {
    const stack = {
      id: "same-stack",
      trunk: { branch: "main" },
      branches: [{ branch: "feature" }],
    }

    expect(normalizeStacks([file(stack), file(stack)])).toHaveLength(1)
  })

  it("keeps the invoking worktree's first snapshot when duplicate IDs disagree", () => {
    const stacks = normalizeStacks([
      file({
        id: "same-stack",
        trunk: { branch: "main" },
        branches: [{ branch: "current" }],
      }),
      file({
        id: "same-stack",
        trunk: { branch: "main" },
        branches: [{ branch: "stale" }],
      }),
    ])

    expect(stacks[0]?.branches.map((branch) => branch.branch)).toEqual(["current"])
  })

  it("resolves a stacked branch before considering shared trunks", () => {
    const stacks = normalizeStacks([
      file({
        id: "one",
        trunk: { branch: "main" },
        branches: [{ branch: "feature-one" }],
      }),
      file({
        id: "two",
        trunk: { branch: "main" },
        branches: [{ branch: "feature-two" }],
      }),
    ])

    expect(stacksForBranch(stacks, "feature-two").map((stack) => stack.id)).toEqual(["two"])
    expect(stacksForBranch(stacks, "main").map((stack) => stack.id)).toEqual(["one", "two"])
  })

  it("preserves ambiguity when a branch is also another stack's trunk", () => {
    const stacks = normalizeStacks([
      file({
        id: "layer",
        trunk: { branch: "main" },
        branches: [{ branch: "shared" }],
      }),
      file({
        id: "trunk",
        trunk: { branch: "shared" },
        branches: [{ branch: "other" }],
      }),
    ])

    expect(stacksForBranch(stacks, "shared").map((stack) => stack.id)).toEqual([
      "layer",
      "trunk",
    ])
  })

  it("loads parent-owned stack state while invoked from a linked worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "heherdr-gh-stack-"))
    const repo = join(root, "repo")
    const checkout = join(root, "feature")
    const runGit = (...args: ReadonlyArray<string>) => {
      const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }

    try {
      runGit("init", "--quiet", repo)
      runGit("-C", repo, "config", "user.email", "heherdr@example.invalid")
      runGit("-C", repo, "config", "user.name", "heherdr test")
      runGit("-C", repo, "commit", "--quiet", "--allow-empty", "-m", "initial")
      runGit("-C", repo, "branch", "-M", "main")
      runGit("-C", repo, "worktree", "add", "--quiet", "-b", "feature", checkout, "HEAD")
      await writeFile(
        join(repo, ".git", "gh-stack"),
        JSON.stringify({
          schemaVersion: 1,
          stacks: [
            {
              id: "stack",
              trunk: { branch: "main" },
              branches: [{ branch: "feature" }],
            },
          ],
        }),
      )

      const catalog = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* GhStackClient
          return yield* client.load({
            projectDir: checkout,
            repoRoot: repo,
            checkoutPaths: [repo, checkout],
          })
        }).pipe(Effect.provide(layer)),
      )

      expect(catalog.currentBranch).toBe("feature")
      expect(catalog.stacks.map((stack) => stack.id)).toEqual(["stack"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
