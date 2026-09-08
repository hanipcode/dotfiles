import { test } from "node:test"
import assert from "node:assert/strict"
import { HerdrActivityState } from "./activity-state.mjs"
import { createHerdrActivityController } from "./activity-controller.mjs"
import { loadHerdrActivity } from "./activity-snapshot.mjs"

const makeState = (id) => new HerdrActivityState(id, [{ id }])
const connected = { type: "server.connected", data: {} }
function harness(load) {
  const reports = []
  const errors = []
  const controller = createHerdrActivityController({ load, client: {},
    reporter: { report: (value) => reports.push(value), release: () => reports.push("release") },
    onError: (error) => errors.push(error),
  })
  return { controller, reports, errors }
}

test("old hydration cannot claim the pane after session switch; old jobs cannot contaminate new root", async () => {
  const pending = new Map()
  const { controller, reports } = harness((client, id, signal) => new Promise((resolve) => pending.set(id, { resolve, signal })))
  await controller.event(connected)
  const first = controller.select("ses_a")
  const second = controller.select("ses_b")
  assert.equal(pending.get("ses_a").signal.aborted, true)
  pending.get("ses_b").resolve(makeState("ses_b"))
  await second
  pending.get("ses_a").resolve(makeState("ses_a"))
  await first
  controller.event({ type: "shell.created", data: { info: { id: "sh_a", status: "running", metadata: { sessionID: "ses_a" } } } })
  assert.deepEqual(reports.filter((report) => report !== "release"), [{ sessionID: "ses_b", state: "idle" }])
})

test("events arriving during attach replay after snapshot without losing background completion", async () => {
  let resolve
  const { controller, reports } = harness(() => new Promise((done) => { resolve = done }))
  await controller.event(connected)
  const selecting = controller.select("ses_a")
  controller.event({ type: "shell.created", data: { info: { id: "sh_a", status: "running", metadata: { sessionID: "ses_a" } } } })
  controller.event({ type: "shell.exited", data: { id: "sh_a", status: "exited" } })
  controller.event({ type: "session.execution.started", data: { sessionID: "ses_a" } })
  resolve(makeState("ses_a"))
  await selecting
  assert.deepEqual(reports.at(-1), { sessionID: "ses_a", state: "working" })
  controller.event({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
  assert.deepEqual(reports.at(-1), { sessionID: "ses_a", state: "idle" })
})

test("disconnect releases busy state; reconnect rehydrates rather than reviving stale jobs", async () => {
  let calls = 0
  const { controller, reports, errors } = harness(async () => { calls++; return makeState("ses_a") })
  await controller.select("ses_a")
  await controller.event(connected)
  controller.event({ type: "session.execution.started", data: { sessionID: "ses_a" } })
  controller.disconnect(new Error("lost stream"))
  assert.equal(reports.at(-1), "release")
  assert.equal(errors.length, 1)
  await controller.event(connected)
  assert.equal(calls, 2)
  assert.deepEqual(reports.at(-1), { sessionID: "ses_a", state: "idle" })
})

test("home navigation and plugin exit release; pending work and events cannot restore ownership", async () => {
  const { controller, reports } = harness(async (client, id) => makeState(id))
  await controller.event(connected)
  await controller.select("ses_a")
  await controller.select(undefined)
  assert.equal(reports.at(-1), "release")
  await controller.select("ses_b")
  controller.stop()
  const count = reports.length
  await controller.select("ses_c")
  controller.event({ type: "session.execution.started", data: { sessionID: "ses_b" } })
  assert.equal(reports.length, count)
  assert.equal(reports.at(-1), "release")
})

test("snapshot failure does not force working or claim successful idle", async () => {
  const { controller, reports, errors } = harness(async () => { throw new Error("snapshot unavailable") })
  await controller.select("ses_a")
  await controller.event(connected)
  assert.equal(errors.length, 1)
  assert.equal(reports.every((report) => report === "release"), true)
})

test("exit aborts pending hydration even if the API ignores cancellation and resolves later", async () => {
  let resolve
  let signal
  const { controller, reports } = harness((client, id, inputSignal) => {
    signal = inputSignal
    return new Promise((done) => { resolve = done })
  })
  await controller.event(connected)
  const selecting = controller.select("ses_a")
  controller.stop()
  assert.equal(signal.aborted, true)
  resolve(makeState("ses_a"))
  await selecting
  assert.equal(reports.every((report) => report === "release"), true)
})

test("snapshot resolves root, paginates descendants, and reads each owned location", async () => {
  const root = { id: "ses_root", location: { directory: "/root" } }
  const child = { id: "ses_child", parentID: root.id, location: { directory: "/child", workspaceID: "wrk_child" } }
  const sibling = { id: "ses_sibling", parentID: root.id, location: root.location }
  const locations = []
  const client = {
    session: {
      get: async ({ sessionID }) => sessionID === child.id ? child : root,
      list: async ({ parentID, cursor }) => ({
        data: parentID === root.id ? cursor ? [sibling] : [child] : [],
        cursor: { next: parentID === root.id && !cursor ? "page2" : null },
      }),
      active: async () => ({ [child.id]: { type: "running" }, ses_unrelated: { type: "running" } }),
    },
    shell: { list: async ({ location }) => {
      locations.push(location.directory)
      if (location.directory === "/child") {
        assert.equal(location.workspace, "wrk_child")
        assert.equal(location.workspaceID, undefined)
      }
      return { data: [{ id: "sh_child", status: "running", metadata: { sessionID: child.id } }] }
    } },
    permission: { list: async () => [] },
    form: { list: async () => [] },
  }
  const activity = await loadHerdrActivity(client, child.id, new AbortController().signal)
  assert.deepEqual(locations.sort(), ["/child", "/root"])
  assert.equal(activity.sessions.size, 3)
  assert.equal(activity.active.size, 1)
  assert.equal(activity.shells.size, 1)
  assert.deepEqual(activity.projection(), { sessionID: root.id, state: "working" })
})
