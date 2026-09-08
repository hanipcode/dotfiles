import type { Socket } from "node:net"

/** Forward output delivery is bounded; only live output may be omitted for a slow reader. */
export interface ForwardOutput {
  readonly write: (frame: string) => void
  readonly end: (frame: string) => void
  readonly droppedBytes: () => number
}

/** Wait for socket drain instead of treating backpressure as a command interruption. */
export const createForwardOutput = (socket: Socket): ForwardOutput => {
  const maximumQueuedBytes = 1024 * 1024
  const frames: Array<string> = []
  let queuedBytes = 0
  let droppedBytes = 0
  let blocked = false
  let finalFrame: string | null = null

  const flush = () => {
    if (socket.destroyed || blocked) return
    while (frames.length > 0) {
      const frame = frames.shift()
      if (frame === undefined) break
      queuedBytes -= Buffer.byteLength(frame)
      // false means the frame was accepted, but the next write must wait for drain.
      if (!socket.write(frame)) {
        blocked = true
        return
      }
    }
    if (finalFrame !== null) {
      socket.end(finalFrame)
      finalFrame = null
    }
  }
  const drain = () => {
    blocked = false
    flush()
  }
  socket.on("drain", drain)
  socket.once("close", () => {
    socket.off("drain", drain)
    frames.length = 0
    queuedBytes = 0
    finalFrame = null
  })

  return {
    write: (frame) => {
      if (socket.destroyed) return
      const bytes = Buffer.byteLength(frame)
      if (queuedBytes + bytes > maximumQueuedBytes) {
        droppedBytes += bytes
        return
      }
      frames.push(frame)
      queuedBytes += bytes
      flush()
    },
    // The terminal result is never dropped and is ordered after accepted output.
    end: (frame) => {
      finalFrame = frame
      flush()
    },
    droppedBytes: () => droppedBytes,
  }
}
