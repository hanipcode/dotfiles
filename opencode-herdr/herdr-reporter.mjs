import net from "node:net"
import { randomUUID } from "node:crypto"

/** Sends bounded local socket requests; the pane and socket are captured from the CLI, never the server. */
export function sendHerdrRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(`${JSON.stringify(request)}\n`))
    let response = ""
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const deadline = setTimeout(() => finish(new Error("Herdr activity: report timed out")), 500)
    socket.on("error", finish)
    socket.on("end", () => finish(new Error("Herdr activity: report ended without response")))
    socket.on("close", () => finish(new Error("Herdr activity: report closed without response")))
    socket.on("data", (chunk) => {
      response += chunk.toString()
      if (response.length > 65536) return finish(new Error("Herdr activity: oversized report response"))
      if (!response.includes("\n")) return
      try {
        const result = JSON.parse(response.slice(0, response.indexOf("\n")))
        if (result.id !== request.id || result.error) throw new Error("Herdr activity: report rejected")
        finish()
      } catch (error) {
        finish(error)
      }
    })
  })
}

/** Serializes selection/state/release using Herdr's full-lifecycle source; stock reporters must be disabled. */
export function createHerdrReporter({ paneID, socketPath, onError, send = sendHerdrRequest }) {
  let sequence = Date.now() * 1000
  let chain = Promise.resolve()
  let owner
  function enqueue(method, params) {
    const request = {
      id: randomUUID(), method,
      params: {
        pane_id: paneID, source: "herdr:opencode", agent: "opencode",
        // Herdr recognizes unsequenced OpenCode `select` as the foreground ownership anchor.
        ...(method === "pane.report_agent_session" ? {} : { seq: ++sequence }),
        ...params,
      },
    }
    chain = chain.then(() => send(socketPath, request)).catch(onError)
  }
  return {
    report({ sessionID, state }) {
      if (owner !== sessionID) {
        owner = sessionID
        enqueue("pane.report_agent_session", { agent_session_id: sessionID, session_start_source: "select" })
      }
      enqueue("pane.report_agent", { agent_session_id: sessionID, state })
    },
    release() {
      if (!owner) return
      owner = undefined
      enqueue("pane.release_agent", {})
    },
    flush() { return chain },
  }
}
