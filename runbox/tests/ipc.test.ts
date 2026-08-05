import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request } from "../src/ipc.ts"

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
})
