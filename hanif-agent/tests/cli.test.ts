import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const help = async (...args: ReadonlyArray<string>): Promise<string> => {
  const child = spawn("bun", [join(packageRoot, "bin", "hanif-agent.ts"), ...args], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
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
  if (exitCode !== 0) throw new Error(stderr || `hanif-agent exited with ${exitCode}`)
  return stdout
}

describe("hanif-agent CLI", () => {
  it("exposes a worktree-only review without a base option", async () => {
    expect(await help("--help")).toContain("review-worktree")

    const output = await help("review-worktree", "--help")
    expect(output).toContain("Review only staged, unstaged, and untracked worktree changes")
    expect(output).not.toContain("--base")
  })

  it("exposes a last-commit review without a base option", async () => {
    expect(await help("--help")).toContain("review-lc")

    const output = await help("review-lc", "--help")
    expect(output).toContain("Review the last commit against its first parent")
    expect(output).not.toContain("--base")
  })
})
