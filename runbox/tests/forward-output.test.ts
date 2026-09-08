import { describe, expect, it } from "vitest"
import { connect, createServer, type Socket } from "node:net"
import { once } from "node:events"
import { createForwardOutput } from "../src/forwardOutput.ts"

describe("forward output backpressure", () => {
  it("keeps a slow connection alive, bounds live output, and delivers the terminal result", async () => {
    let peer: Socket | undefined
    let dropped = 0
    let reportQueued: () => void = () => {}
    const queued = new Promise<void>((resolve) => { reportQueued = resolve })
    const server = createServer((socket) => {
      peer = socket
      const output = createForwardOutput(socket)
      output.write("start\n")
      for (let index = 0; index < 2048; index++) output.write(`${"x".repeat(8192)}\n`)
      dropped = output.droppedBytes()
      output.end("final-result\n")
      reportQueued()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("TCP fixture did not bind")
    const client = connect(address.port, "127.0.0.1")
    client.pause()
    try {
      await once(client, "connect")
      await queued
      expect(peer?.destroyed).toBe(false)
      expect(dropped).toBeGreaterThan(0)
      let output = ""
      client.setEncoding("utf8").on("data", (text: string) => { output += text })
      client.resume()
      await once(client, "end")
      expect(output.startsWith("start\n")).toBe(true)
      expect(output.endsWith("final-result\n")).toBe(true)
      expect(Buffer.byteLength(output)).toBeLessThan(4 * 1024 * 1024)
    } finally {
      client.destroy()
      peer?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
