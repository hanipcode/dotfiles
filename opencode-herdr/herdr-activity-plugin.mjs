import { createEffect } from "solid-js"
import { setupHerdrActivity } from "./activity-plugin-setup.mjs"

/** CLI-only OpenCode V2 plugin: observing a session does not imply ownership of other panes or roots. */
export default {
  id: "hanif.herdr-activity",
  setup(context) {
    return setupHerdrActivity(context, { createEffect })
  },
}
