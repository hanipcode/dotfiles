/** Aggregates only one selected root session and its descendants; never tool-call lifetimes. */
export class HerdrActivityState {
  constructor(rootID, sessions = [], active = {}, shells = [], permissions = [], forms = []) {
    this.rootID = rootID
    this.sessions = new Map(sessions.map((session) => [session.id, session]))
    this.active = new Set(Object.keys(active).filter((id) => this.sessions.has(id)))
    this.shells = new Map(shells.filter((shell) => shell.status === "running" &&
      this.sessions.has(shell.metadata.sessionID)).map((shell) => [shell.id, shell.metadata.sessionID]))
    this.permissions = new Map(permissions.filter((request) => this.sessions.has(request.sessionID))
      .map((request) => [request.id, request.sessionID]))
    this.forms = new Map(forms.filter((form) => this.sessions.has(form.sessionID))
      .map((form) => [form.id, form.sessionID]))
  }

  removeSession(sessionID) {
    const removed = new Set([sessionID])
    for (const id of removed) {
      for (const session of this.sessions.values()) {
        if (session.parentID === id) removed.add(session.id)
      }
    }
    for (const id of removed) {
      this.sessions.delete(id)
      this.active.delete(id)
    }
    for (const registry of [this.shells, this.permissions, this.forms]) {
      for (const [id, owner] of registry) if (removed.has(owner)) registry.delete(id)
    }
    if (removed.has(this.rootID)) this.rootID = undefined
  }

  apply(event) {
    const data = event.data
    if (event.type === "session.created" && this.sessions.has(data.parentID)) {
      this.sessions.set(data.sessionID, { id: data.sessionID, parentID: data.parentID, location: data.location })
    }
    if (event.type === "shell.created") {
      const shell = data.info
      if (shell.status === "running" && this.sessions.has(shell.metadata.sessionID)) {
        this.shells.set(shell.id, shell.metadata.sessionID)
      }
    }
    if (event.type === "shell.exited" || event.type === "shell.deleted") this.shells.delete(data.id)
    if (event.type === "form.created" && this.sessions.has(data.form.sessionID)) {
      this.forms.set(data.form.id, data.form.sessionID)
    }
    if (!this.sessions.has(data.sessionID)) return
    switch (event.type) {
      case "session.execution.started":
        this.active.add(data.sessionID)
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.active.delete(data.sessionID)
        // Terminal execution dismisses its requests, not independently running shells/children.
        for (const registry of [this.permissions, this.forms]) {
          for (const [id, owner] of registry) if (owner === data.sessionID) registry.delete(id)
        }
        break
      case "permission.asked":
        this.permissions.set(data.id, data.sessionID)
        break
      case "permission.replied":
        this.permissions.delete(data.requestID)
        break
      case "form.replied":
      case "form.cancelled":
        this.forms.delete(data.id)
        break
      case "session.deleted":
        this.removeSession(data.sessionID)
        break
    }
  }

  projection() {
    if (!this.rootID) return undefined
    const state = this.permissions.size || this.forms.size ? "blocked"
      : this.active.size || this.shells.size ? "working" : "idle"
    return { sessionID: this.rootID, state }
  }
}
