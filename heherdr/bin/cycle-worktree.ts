#!/usr/bin/env bun

import { cycleWorkspaceId, type CycleDirection } from "../src/plugins/worktree-cycle/model.ts"

type JsonRecord = { readonly [key: string]: unknown }

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, description: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`invalid herdr response: missing ${description}`)
  return value
}

const requireString = (value: unknown, description: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Error(`invalid herdr response: missing ${description}`)
  }
  return value
}

const runHerdr = async (args: ReadonlyArray<string>): Promise<JsonRecord> => {
  const herdr = process.env["HERDR_BIN_PATH"] || "herdr"
  const processHandle = Bun.spawn([herdr, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `herdr ${args.join(" ")} exited ${exitCode}`)
  }

  const parsed: unknown = JSON.parse(stdout)
  const envelope = requireRecord(parsed, "JSON envelope")
  if (isRecord(envelope["error"])) {
    throw new Error(requireString(envelope["error"]["message"], "error.message"))
  }
  return requireRecord(envelope["result"], "result")
}

const parseDirection = (value: string | undefined): CycleDirection => {
  if (value === "next" || value === "previous") return value
  throw new Error("usage: cycle-worktree.ts <next|previous>")
}

const cycle = async (): Promise<void> => {
  const direction = parseDirection(process.argv[2])
  const currentWorkspaceId =
    process.env["HERDR_ACTIVE_WORKSPACE_ID"] || process.env["HERDR_WORKSPACE_ID"]
  if (currentWorkspaceId === undefined) throw new Error("no active herdr workspace")

  const [worktreeResult, workspaceResult] = await Promise.all([
    runHerdr(["worktree", "list", "--workspace", currentWorkspaceId]),
    runHerdr(["workspace", "list"]),
  ])

  const source = requireRecord(worktreeResult["source"], "worktree source")
  const mainWorkspaceId = requireString(source["source_workspace_id"], "source workspace id")
  const worktrees = worktreeResult["worktrees"]
  const workspaces = workspaceResult["workspaces"]
  if (!Array.isArray(worktrees) || !Array.isArray(workspaces)) {
    throw new Error("invalid herdr response: missing workspace lists")
  }

  const openWorkspaceIds = new Set(
    worktrees.flatMap((worktree) => {
      if (!isRecord(worktree) || typeof worktree["open_workspace_id"] !== "string") return []
      return [worktree["open_workspace_id"]]
    }),
  )
  const sessionWorkspaceIds = workspaces.map((workspace) =>
    requireString(requireRecord(workspace, "workspace")["workspace_id"], "workspace id"),
  )
  const targetWorkspaceId = cycleWorkspaceId(
    currentWorkspaceId,
    mainWorkspaceId,
    openWorkspaceIds,
    sessionWorkspaceIds,
    direction,
  )

  if (targetWorkspaceId !== undefined) {
    await runHerdr(["workspace", "focus", targetWorkspaceId])
  }
}

await cycle().catch((error: unknown) => {
  console.error(`heherdr worktree cycle: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
