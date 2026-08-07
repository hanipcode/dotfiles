import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request, requestForward } from "../src/ipc.ts"

describe("IPC", () => {
  it("fails when a daemon closes without responding", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-ipc-"))
    const socketPath = join(root, "daemon.sock")
    const connections: Array<Socket> = []
    const server = createServer((socket) => {
      connections.push(socket)
      socket.end()
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const exit = await Effect.runPromiseExit(request(socketPath, { type: "shutdown" }, 1_000))
    expect(exit._tag).toBe("Failure")
    server.close()
    for (const connection of connections) connection.destroy()
    await rm(root, { recursive: true, force: true })
  })

  it("streams forwarded output before returning the final result", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-forward-ipc-"))
    const socketPath = join(root, "daemon.sock")
    const server = createServer((socket) => {
      socket.once("data", () => {
        const start = {
          invocationId: "invocation",
          argv: ["pnpm", "install"],
          cwd: "/runner",
          sourceCommit: "abc123",
          startedAt: 1,
          logFile: "/logs/forward.log",
        }
        socket.write(`${JSON.stringify({ type: "start", data: start })}\n`)
        socket.write(`${JSON.stringify({ type: "output", stream: "stdout", text: "installing\n" })}\n`)
        socket.end(`${JSON.stringify({
          ok: true,
          protocolVersion: 2,
          forward: {
            ...start,
            started: true,
            finishedAt: 2,
            durationMs: 1,
            exitCode: 0,
            signal: null,
            warnings: [],
          },
        })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const output: Array<string> = []
    const response = await Effect.runPromise(requestForward(socketPath, {
      type: "forward",
      packagePath: "",
      argv: ["pnpm", "install"],
      source: {
        kind: "worktree",
        worktreePath: "/source",
        branch: "main",
        commit: "abc123",
        stack: null,
      },
    }, {
      onStart: (start) => output.push(start.invocationId),
      onOutput: (_stream, text) => output.push(text),
    }))
    expect(output).toEqual(["invocation", "installing\n"])
    expect(response).toMatchObject({ ok: true, forward: { exitCode: 0 } })
    server.close()
    await rm(root, { recursive: true, force: true })
  })

  it("marks a lost forward connection as unsafe to retry after startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "runbox-forward-lost-ipc-"))
    const socketPath = join(root, "daemon.sock")
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(`${JSON.stringify({
          type: "start",
          data: {
            invocationId: "lost",
            argv: ["pnpm", "install"],
            cwd: "/runner",
            sourceCommit: "abc123",
            startedAt: 1,
            logFile: "/logs/forward.log",
          },
        })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const exit = await Effect.runPromiseExit(requestForward(socketPath, {
      type: "forward",
      packagePath: "",
      argv: ["pnpm", "install"],
      source: {
        kind: "worktree",
        worktreePath: "/source",
        branch: "main",
        commit: "abc123",
        stack: null,
      },
    }, { onStart: () => {}, onOutput: () => {} }))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toMatchObject({ code: "DAEMON_UNAVAILABLE", retryable: false })
      expect(exit.cause.error.details).toContain('"started":true')
    }
    server.close()
    await rm(root, { recursive: true, force: true })
  })
})
