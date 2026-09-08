import { test } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtemp, rmdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHerdrReporter, sendHerdrRequest } from "./herdr-reporter.mjs"

test("selection, state changes, release, and next root remain serialized and sequenced", async () => {
  const requests = []
  const reporter = createHerdrReporter({ paneID: "test:pane", socketPath: "test.sock", onError: assert.fail,
    send: async (socket, request) => { await Promise.resolve(); requests.push(request) },
  })
  reporter.report({ sessionID: "ses_a", state: "working" })
  reporter.report({ sessionID: "ses_a", state: "blocked" })
  reporter.release()
  reporter.report({ sessionID: "ses_b", state: "idle" })
  reporter.release()
  reporter.release()
  await reporter.flush()
  assert.deepEqual(requests.map((request) => request.method), [
    "pane.report_agent_session", "pane.report_agent", "pane.report_agent", "pane.release_agent",
    "pane.report_agent_session", "pane.report_agent", "pane.release_agent",
  ])
  let previousSequence = 0
  for (const request of requests) {
    assert.equal(request.params.pane_id, "test:pane")
    assert.equal(request.params.source, "herdr:opencode")
    if (request.params.seq !== undefined) {
      assert.ok(request.params.seq > previousSequence)
      previousSequence = request.params.seq
    }
  }
  assert.equal(requests[0].params.session_start_source, "select")
  assert.equal(requests[0].params.seq, undefined)
})

test("independent pane reporters have no shared session ownership", async () => {
  const requests = []
  const create = (paneID) => createHerdrReporter({ paneID, socketPath: "fake", onError: assert.fail,
    send: async (socket, request) => requests.push(request),
  })
  const a = create("pane_a")
  const b = create("pane_b")
  a.report({ sessionID: "ses_a", state: "working" })
  b.report({ sessionID: "ses_b", state: "idle" })
  a.release()
  await Promise.all([a.flush(), b.flush()])
  assert.equal(requests.filter((request) => request.method === "pane.release_agent").length, 1)
  assert.equal(requests.find((request) => request.method === "pane.release_agent").params.pane_id, "pane_a")
})

test("failed report does not poison the queue or prevent a subsequent release", async () => {
  const requests = []
  const errors = []
  const reporter = createHerdrReporter({ paneID: "test:pane", socketPath: "fake",
    onError: (error) => errors.push(error),
    send: async (socket, request) => {
      requests.push(request)
      if (request.method === "pane.report_agent") throw new Error("transport failed")
    },
  })
  reporter.report({ sessionID: "ses_a", state: "working" })
  reporter.release()
  await reporter.flush()
  assert.equal(errors.length, 1)
  assert.equal(requests.at(-1).method, "pane.release_agent")
})

test("socket protocol handles split response frames and rejects errors", async () => {
  // A private test socket only: never connects to the running Herdr process.
  const directory = await mkdtemp(path.join(tmpdir(), "herdr-test-"))
  const socketPath = path.join(directory, "state.sock")
  const server = net.createServer((socket) => {
    let text = ""
    socket.on("data", (chunk) => {
      text += chunk
      if (!text.includes("\n")) return
      const request = JSON.parse(text)
      const response = JSON.stringify({ id: request.id, ...(request.id === "bad" ? { error: { message: "no" } } : { result: {} }) })
      socket.write(response.slice(0, 4))
      socket.end(`${response.slice(4)}\n`)
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  try {
    await sendHerdrRequest(socketPath, { id: "ok" })
    await assert.rejects(sendHerdrRequest(socketPath, { id: "bad" }), /report rejected/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rmdir(directory)
  }
})
