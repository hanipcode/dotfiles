import { test } from "node:test"
import assert from "node:assert/strict"
import { HerdrActivityState } from "./activity-state.mjs"

const event = (type, data) => ({ type, data })
const root = { id: "ses_root" }
const child = { id: "ses_child", parentID: root.id }
const shell = (id, sessionID = root.id, status = "running") => ({ id, status, metadata: { sessionID } })
const fresh = () => new HerdrActivityState(root.id, [root, child])
const state = (activity) => activity.projection()?.state

for (const order of [["sh_a", "sh_b"], ["sh_b", "sh_a"]]) {
  test(`parallel jobs finish ${order.join(" then ")}; root idle does not end job lifetime`, () => {
    const activity = fresh()
    activity.apply(event("session.execution.started", { sessionID: root.id }))
    for (const id of order) activity.apply(event("shell.created", { info: shell(id) }))
    activity.apply(event("session.execution.succeeded", { sessionID: root.id }))
    assert.equal(state(activity), "working")
    activity.apply(event("shell.exited", { id: order[0], status: "exited", exit: 0 }))
    assert.equal(state(activity), "working")
    activity.apply(event("shell.deleted", { id: order[0] }))
    assert.equal(state(activity), "working")
    activity.apply(event("shell.exited", { id: order[1], status: "exited", exit: 0 }))
    assert.equal(state(activity), "idle")
  })
}

test("child completion cannot clear another child, root turn, or child-owned shell", () => {
  const activity = fresh()
  activity.apply(event("session.created", { sessionID: "ses_grandchild", parentID: child.id }))
  for (const sessionID of [root.id, child.id, "ses_grandchild"]) {
    activity.apply(event("session.execution.started", { sessionID }))
  }
  activity.apply(event("shell.created", { info: shell("sh_child", child.id) }))
  for (const sessionID of [child.id, root.id, "ses_grandchild"]) {
    activity.apply(event("session.execution.succeeded", { sessionID }))
    assert.equal(state(activity), "working")
    assert.equal(activity.projection().sessionID, root.id)
  }
  activity.apply(event("shell.exited", { id: "sh_child", status: "exited" }))
  assert.equal(state(activity), "idle")
})

test("blocked precedence uses request identities, not a reply-implies-working guess", () => {
  const activity = fresh()
  activity.apply(event("shell.created", { info: shell("sh_a") }))
  activity.apply(event("permission.asked", { id: "per_a", sessionID: root.id }))
  activity.apply(event("form.created", { form: { id: "form_a", sessionID: child.id } }))
  activity.apply(event("permission.replied", { requestID: "per_a", sessionID: root.id, reply: "reject" }))
  assert.equal(state(activity), "blocked")
  activity.apply(event("shell.exited", { id: "sh_a", status: "exited" }))
  assert.equal(state(activity), "blocked")
  activity.apply(event("form.cancelled", { id: "form_a", sessionID: child.id }))
  assert.equal(state(activity), "idle")
})

for (const terminal of ["session.execution.failed", "session.execution.interrupted"]) {
  test(`${terminal} clears only its turn/requests, not independently live jobs`, () => {
    const activity = fresh()
    activity.apply(event("session.execution.started", { sessionID: root.id }))
    activity.apply(event("permission.asked", { id: "per_a", sessionID: root.id }))
    activity.apply(event("shell.created", { info: shell("sh_a") }))
    activity.apply(event(terminal, { sessionID: root.id }))
    assert.equal(state(activity), "working")
    activity.apply(event("shell.exited", { id: "sh_a", status: "killed" }))
    assert.equal(state(activity), "idle")
  })
}

for (const terminal of ["exited", "timeout", "killed"]) {
  test(`shell terminal ${terminal} removes failed/cancelled work`, () => {
    const activity = fresh()
    activity.apply(event("shell.created", { info: shell("sh_a") }))
    activity.apply(event("shell.exited", { id: "sh_a", status: terminal, exit: 1 }))
    assert.equal(state(activity), "idle")
  })
}

test("unrelated roots, unowned shells, global forms, and tool returns cannot affect the pane", () => {
  const activity = fresh()
  activity.apply(event("session.created", { sessionID: "ses_other" }))
  activity.apply(event("session.execution.started", { sessionID: "ses_other" }))
  activity.apply(event("shell.created", { info: shell("sh_other", "ses_other") }))
  activity.apply(event("shell.created", { info: { id: "sh_api", status: "running", metadata: {} } }))
  activity.apply(event("permission.asked", { id: "per_other", sessionID: "ses_other" }))
  activity.apply(event("form.created", { form: { id: "form_global", sessionID: "global" } }))
  activity.apply(event("session.tool.success", { sessionID: root.id }))
  assert.equal(state(activity), "idle")
})

test("session deletion removes subtree activity and root deletion releases projection", () => {
  const activity = fresh()
  activity.apply(event("session.created", { sessionID: "ses_nested", parentID: child.id }))
  activity.apply(event("session.execution.started", { sessionID: "ses_nested" }))
  activity.apply(event("shell.created", { info: shell("sh_nested", "ses_nested") }))
  activity.apply(event("permission.asked", { id: "per_nested", sessionID: "ses_nested" }))
  activity.apply(event("session.deleted", { sessionID: child.id }))
  assert.equal(state(activity), "idle")
  activity.apply(event("session.deleted", { sessionID: root.id }))
  assert.equal(activity.projection(), undefined)
})

test("hydration includes pre-existing active children, requests and only running owned shells", () => {
  const activity = new HerdrActivityState(root.id, [root, child], { [child.id]: { type: "running" } },
    [shell("sh_a"), shell("sh_dead", root.id, "exited"), shell("sh_other", "ses_other")],
    [{ id: "per_a", sessionID: child.id }])
  assert.equal(state(activity), "blocked")
  assert.equal(activity.shells.size, 1)
  activity.apply(event("permission.replied", { requestID: "per_a", sessionID: child.id }))
  assert.equal(state(activity), "working")
})
