import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { setImmediate } from "node:timers/promises"
import { setupHerdrActivity } from "./activity-plugin-setup.mjs"

function pluginHarness() {
  let route = { type: "session", sessionID: "ses_root" }
  let observe
  let streamSignal
  let deliver
  let reportError
  let removed = 0
  const reports = []
  const toasts = []
  const context = {
    renderer: new EventEmitter(),
    ui: {
      router: { current: () => route },
      toast: { show: (toast) => toasts.push(toast) },
      slot: ({ render }) => { render(); return () => { removed++ } },
    },
    client: {
      event: { subscribe: ({ signal }) => {
        streamSignal = signal
        return {
          [Symbol.asyncIterator]() { return this },
          next() { return new Promise((resolve) => { deliver = resolve; signal.addEventListener("abort", () => resolve({ done: true }), { once: true }) }) },
        }
      } },
      session: {
        get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "/test" } }),
        list: async () => ({ data: [], cursor: { next: null } }),
        active: async () => ({}),
      },
      shell: { list: async () => ({ data: [] }) },
      permission: { list: async () => [] },
      form: { list: async () => [] },
    },
  }
  const cleanup = setupHerdrActivity(context, {
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "test:pane", HERDR_SOCKET_PATH: "test.sock" },
    createEffect: (callback) => { observe = callback; callback() },
    createReporter: ({ paneID, socketPath, onError }) => {
      assert.equal(paneID, "test:pane")
      assert.equal(socketPath, "test.sock")
      reportError = onError
      return { report: (report) => reports.push(report), release: () => reports.push("release"), flush: async () => {} }
    },
  })
  return {
    context, reports, toasts, cleanup,
    get removed() { return removed },
    get aborted() { return streamSignal.aborted },
    async event(type, data = {}) { deliver({ value: { type, data }, done: false }); await setImmediate() },
    async end() { deliver({ done: true }); await setImmediate() },
    async reportFailure() { reportError(new Error("socket failed")); await setImmediate() },
    async navigate(next) { route = next; observe(); await setImmediate() },
  }
}

test("CLI wiring keeps activity after root ends, gives input precedence, and releases on renderer exit", async () => {
  const plugin = pluginHarness()
  await plugin.event("server.connected")
  assert.deepEqual(plugin.reports.at(-1), { sessionID: "ses_root", state: "idle" })
  await plugin.event("shell.created", { info: { id: "sh_job", status: "running", metadata: { sessionID: "ses_root" } } })
  await plugin.event("session.execution.succeeded", { sessionID: "ses_root" })
  assert.equal(plugin.reports.at(-1).state, "working")
  await plugin.event("form.created", { form: { id: "form_input", sessionID: "ses_root" } })
  assert.equal(plugin.reports.at(-1).state, "blocked")
  await plugin.event("form.replied", { id: "form_input", sessionID: "ses_root" })
  assert.equal(plugin.reports.at(-1).state, "working")
  await plugin.event("shell.exited", { id: "sh_job", status: "exited", exit: 0 })
  assert.equal(plugin.reports.at(-1).state, "idle")
  plugin.context.renderer.emit("destroy")
  assert.equal(plugin.aborted, true)
  assert.equal(plugin.reports.at(-1), "release")
  assert.equal(plugin.removed, 1)
  await plugin.cleanup()
  assert.equal(plugin.removed, 1)
})

test("CLI route changes do not require polling and release old root activity", async () => {
  const plugin = pluginHarness()
  await plugin.event("server.connected")
  await plugin.navigate({ type: "session", sessionID: "ses_other" })
  assert.deepEqual(plugin.reports.at(-1), { sessionID: "ses_other", state: "idle" })
  await plugin.event("session.execution.started", { sessionID: "ses_root" })
  assert.equal(plugin.reports.at(-1).state, "idle")
  await plugin.navigate({ type: "home" })
  assert.equal(plugin.reports.at(-1), "release")
  await plugin.cleanup()
})

for (const failure of ["end", "reportFailure"]) {
  test(`CLI ${failure} clears authority and warns rather than leaving a permanent busy report`, async () => {
    const plugin = pluginHarness()
    await plugin.event("server.connected")
    await plugin.event("session.execution.started", { sessionID: "ses_root" })
    await plugin[failure]()
    assert.equal(plugin.reports.at(-1), "release")
    assert.equal(plugin.toasts.length, 1)
    await plugin.cleanup()
  })
}

test("outside Herdr the plugin does not read APIs, create slots, or report", () => {
  assert.equal(setupHerdrActivity({}, { env: {}, createEffect: assert.fail, createReporter: assert.fail }), undefined)
})
