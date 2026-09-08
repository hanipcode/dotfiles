import { describe, expect, it } from "vitest"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const exec = promisify(execFile)
const cli = resolve("bin/hanif-agent.ts")
const fixture = resolve("tests/fixtures/fake-codex")

const invoke = async (repo: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => {
  const child = spawn("bun", [cli, ...args, "--repo", repo, "--json"], {
    env: { ...process.env, HANIF_AGENT_CODEX_BIN: fixture, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  return { code, stdout, stderr }
}

describe("agent review CLI protocol", () => {
  it("returns one failure JSON object for invalid options", async () => {
    const result = await invoke(resolve("."), ["review-worktree", "--timeout-seconds", "0"])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, ok: false, status: "failed" })
  })

  it("fails preflight before snapshot work when the reviewer executable is missing", async () => {
    const result = await invoke(resolve("."), ["review-preflight"], { HANIF_AGENT_CODEX_BIN: "/nonexistent/hanif-agent-codex" })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "failed",
      error: { message: "Codex executable is unavailable or its help command failed" } })
  })
  it("reports incomplete coverage with sanitized diagnostics and retries only compatible Luna checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "hanif-agent-protocol-"))
    const repo = join(root, "repo")
    try {
      await exec("git", ["init", "-b", "main", repo])
      await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
      await exec("git", ["-C", repo, "config", "user.name", "Test"])
      await writeFile(join(repo, "app.ts"), "export const value = 1\n")
      await exec("git", ["-C", repo, "add", "."])
      await exec("git", ["-C", repo, "commit", "-m", "initial"])
      await writeFile(join(repo, "app.ts"), "export const value = 2\n")
      const first = await invoke(repo, ["review-worktree"], { FAKE_CODEX_MODE: "failure" })
      expect(first.code, first.stdout + first.stderr).toBe(2)
      const result = JSON.parse(first.stdout)
      expect(result).toMatchObject({ schemaVersion: 1, ok: false, status: "incomplete" })
      expect(result.data.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "luna-standards-modules", status: "failed", attempts: 2,
          error: expect.objectContaining({ message: expect.stringContaining("provider unavailable") }) }),
      ]))
      expect(first.stdout).not.toContain("test-secret")
      expect(first.stdout).not.toContain("test-bearer")
      expect(first.stderr).not.toContain("clipboard")
      const history = await readFile(result.data.historyPath, "utf8")
      expect(history).toContain("provider unavailable")
      expect(history).not.toContain("test-secret")
      const inspected = await invoke(repo, ["review-status", "--run", result.data.runId])
      expect(JSON.parse(inspected.stdout).data.status).toBe("incomplete")
      const log = join(root, "retry.jsonl")
      const retried = await invoke(repo, ["review-retry", "--run", result.data.runId], { FAKE_CODEX_LOG: log })
      expect(retried.code).toBe(0)
      const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(calls.filter((call) => call.event === "started").map((call) => call.role).sort())
        .toEqual(["astra-independent", "astra-reconcile", "standards-modules"])
      await writeFile(join(repo, "app.ts"), "export const value = 3\n")
      const stale = await invoke(repo, ["review-retry", "--run", result.data.runId])
      expect(stale.code).toBe(1)
      expect(JSON.parse(stale.stdout).status).toBe("failed")
      const nested = await invoke(repo, ["review-worktree", "--progress", "json"], {
        FAKE_CODEX_MODE: "nested-retry", FAKE_CODEX_LOG: join(root, "nested.jsonl"),
      })
      expect(nested.code, nested.stdout + nested.stderr).toBe(0)
      expect(JSON.parse(nested.stdout).data.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "luna-standards-modules", status: "succeeded", attempts: 4 }),
      ]))
      const attempts = nested.stderr.trim().split("\n").map((line) => JSON.parse(line))
        .filter((event) => event.type === "attempt_started" && event.role === "luna-standards-modules")
      expect(attempts.map((event) => event.attempt)).toEqual([1, 2, 3, 4])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("starts Astra independently alongside all four Luna reviewers before reconciling", async () => {
    const root = await mkdtemp(join(tmpdir(), "hanif-agent-parallel-"))
    const repo = join(root, "repo")
    try {
      await exec("git", ["init", "-b", "main", repo])
      await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
      await exec("git", ["-C", repo, "config", "user.name", "Test"])
      await writeFile(join(repo, "app.ts"), "export const value = 1\n")
      await exec("git", ["-C", repo, "add", "."])
      await exec("git", ["-C", repo, "commit", "-m", "initial"])
      await writeFile(join(repo, "app.ts"), "export const value = 2\n")
      const log = join(root, "calls.jsonl")
      const preflight = await invoke(repo, ["review-preflight", "--base", "HEAD"], { FAKE_CODEX_LOG: log })
      expect(preflight.code, preflight.stdout + preflight.stderr).toBe(0)
      expect(JSON.parse(preflight.stdout).data).toMatchObject({ changedPathCount: 1, providerAccess: "not-tested" })
      const result = await invoke(repo, ["review-worktree"], {
        FAKE_CODEX_LOG: log, FAKE_CODEX_BARRIER: join(root, "barrier"),
      })
      expect(result.code).toBe(0)
      const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(calls.slice(0, 5).every((call) => call.event === "started")).toBe(true)
      const independent = calls.find((call) => call.role === "astra-independent" && call.event === "started")
      expect(independent.args).toContain("gpt-6-astra")
      expect(independent.prompt).not.toContain("Luna local evidence")
      expect(calls.at(-1)).toMatchObject({ role: "astra-reconcile", event: "finished" })
      await writeFile(join(repo, "app.ts"), "export const value = 3\n")
      const retained = await invoke(repo, ["review-worktree"], { FAKE_CODEX_MODE: "independent-finding" })
      expect(retained.code).toBe(0)
      expect(JSON.parse(retained.stdout).data.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "Independent finding marker", status: "open", sources: ["astra-independent"] }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.each([
    { mode: "timeout", kind: "timeout", code: 2 },
    { mode: "malformed", kind: "output", code: 2 },
    { mode: "astra-failure", kind: "provider", code: 1 },
  ])("reports $mode through the real CLI and saved history", async ({ mode, kind, code }) => {
    const root = await mkdtemp(join(tmpdir(), "hanif-agent-failure-"))
    const repo = join(root, "repo")
    try {
      await exec("git", ["init", "-b", "main", repo])
      await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
      await exec("git", ["-C", repo, "config", "user.name", "Test"])
      await writeFile(join(repo, "app.ts"), "export const value = 1\n")
      await exec("git", ["-C", repo, "add", "."])
      await exec("git", ["-C", repo, "commit", "-m", "initial"])
      await writeFile(join(repo, "app.ts"), "export const value = 2\n")
      const result = await invoke(repo, ["review-worktree", "--timeout-seconds", "1", "--progress", "json"], { FAKE_CODEX_MODE: mode })
      expect(result.code, result.stdout + result.stderr).toBe(code)
      const output = JSON.parse(result.stdout)
      const runId = output.data?.runId ?? output.run?.runId
      expect(runId).toEqual(expect.any(String))
      const inspected = await invoke(repo, ["review-result", "--run", runId])
      const stored = JSON.parse(inspected.stdout).data
      expect(stored.status).toBe(code === 2 ? "incomplete" : "failed")
      expect(stored.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "failed", attempts: 2, error: expect.objectContaining({ kind }) }),
      ]))
      const events = result.stderr.trim().split("\n").map((line) => JSON.parse(line))
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "run_started", runId })]))
      if (mode === "timeout") {
        const firstActivity = events.findIndex((event) => event.type === "stage_activity" && event.role === "luna-standards-modules")
        const firstTimeout = events.findIndex((event) => event.type === "attempt_failed" && event.error.kind === "timeout")
        expect(firstActivity).toBeGreaterThan(-1)
        expect(firstTimeout).toBeGreaterThan(firstActivity)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
