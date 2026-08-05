#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"

const [executable, ...args] = process.argv.slice(2)
if (executable === undefined) {
  process.stderr.write("runbox process wrapper: missing command\n")
  process.exit(64)
}

const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: false,
  stdio: ["ignore", "inherit", "inherit"],
})

const exitCode = await new Promise<number>((resolve) => {
  child.once("error", (cause) => {
    process.stderr.write(`runbox process wrapper: ${String(cause)}\n`)
    resolve(-1)
  })
  child.once("exit", (code) => resolve(code ?? -1))
})

const groupMembers = (): ReadonlyArray<number> => {
  const result = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })
  if (result.status !== 0) return []
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (match === null || Number(match[2]) !== process.pid || Number(match[1]) === process.pid) return []
    return [Number(match[1])]
  })
}

const remaining = groupMembers()
for (const pid of remaining) {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // Already exited.
  }
}
if (remaining.length > 0) await Bun.sleep(1_000)
for (const pid of groupMembers()) {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Graceful cleanup completed.
  }
}

process.exit(exitCode < 0 ? 1 : exitCode)
