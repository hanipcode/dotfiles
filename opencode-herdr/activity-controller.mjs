import { loadHerdrActivity } from "./activity-snapshot.mjs"

const activityEvents = new Set([
  "session.created", "session.deleted", "session.execution.started", "session.execution.succeeded",
  "session.execution.failed", "session.execution.interrupted", "shell.created", "shell.exited",
  "shell.deleted", "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
])

/** Owns a pane's event stream; stale hydration and old-session events cannot restore released activity. */
export function createHerdrActivityController({ client, reporter, onError, load = loadHerdrActivity }) {
  let selectedID
  let connected = false
  let stopped = false
  let generation = 0
  let pending
  let activity
  let lastProjection

  function clear() {
    generation += 1
    pending?.controller.abort()
    pending = undefined
    activity = undefined
    lastProjection = undefined
    reporter.release()
  }

  function publish() {
    const projection = activity?.projection()
    if (!projection) {
      clear()
      return
    }
    const key = JSON.stringify(projection)
    if (lastProjection === key) return
    lastProjection = key
    reporter.report(projection)
  }

  async function hydrate() {
    clear()
    if (!selectedID || !connected || stopped) return
    const current = { generation, controller: new AbortController(), events: [] }
    pending = current
    try {
      const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(10_000)])
      const snapshot = await load(client, selectedID, signal)
      if (stopped || generation !== current.generation) return
      // Subscribe first, snapshot second, replay buffered lifecycle edges last.
      for (const event of current.events) snapshot.apply(event)
      pending = undefined
      activity = snapshot
      publish()
    } catch (error) {
      if (stopped || generation !== current.generation) return
      clear()
      onError(error)
    }
  }

  return {
    select(sessionID) {
      if (stopped || sessionID === selectedID) return
      selectedID = sessionID
      return hydrate()
    },
    event(event) {
      if (stopped) return
      if (event.type === "server.connected") {
        connected = true
        return hydrate()
      }
      if (event.type === "global.disposed") {
        connected = false
        clear()
        return
      }
      if (!activityEvents.has(event.type)) return
      if (pending) pending.events.push(event)
      else if (activity) {
        activity.apply(event)
        publish()
      }
    },
    disconnect(error) {
      if (stopped) return
      connected = false
      clear()
      onError(error)
    },
    stop() {
      stopped = true
      selectedID = undefined
      clear()
    },
  }
}
