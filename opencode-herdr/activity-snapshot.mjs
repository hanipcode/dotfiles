import { HerdrActivityState } from "./activity-state.mjs"

/** Hydrates the selected root family on attach/reconnect, including jobs started before plugin load. */
export async function loadHerdrActivity(client, selectedID, signal) {
  const options = { signal }
  let root = await client.session.get({ sessionID: selectedID }, options)
  const ancestors = new Set()
  while (root.parentID) {
    if (ancestors.has(root.id)) throw new Error("Herdr activity: cyclic session ancestry")
    ancestors.add(root.id)
    root = await client.session.get({ sessionID: root.parentID }, options)
  }
  const sessions = new Map([[root.id, root]])
  for (const session of sessions.values()) {
    let cursor
    const cursors = new Set()
    do {
      const page = await client.session.list({ parentID: session.id, limit: 100, cursor }, options)
      for (const child of page.data) {
        if (child.parentID === session.id) sessions.set(child.id, child)
      }
      cursor = page.cursor.next ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error("Herdr activity: repeated session cursor")
      cursors.add(cursor)
    } while (cursor)
  }
  const family = [...sessions.values()]
  const locations = new Map(family.map((session) => [JSON.stringify(session.location), session.location]))
  const [active, shellPages, permissions, forms] = await Promise.all([
    client.session.active(options),
    Promise.all([...locations.values()].map((location) => client.shell.list({
      location: { directory: location.directory, workspace: location.workspaceID },
    }, options))),
    Promise.all(family.map((session) => client.permission.list({ sessionID: session.id }, options))),
    Promise.all(family.map((session) => client.form.list({ sessionID: session.id }, options))),
  ])
  return new HerdrActivityState(root.id, family, active, shellPages.flatMap((page) => page.data),
    permissions.flat(), forms.flat())
}
