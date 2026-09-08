import { createHerdrActivityController } from "./activity-controller.mjs"
import { createHerdrReporter } from "./herdr-reporter.mjs"

/** Connects CLI route, event stream, and renderer lifetimes without requiring a live pane in tests. */
export function setupHerdrActivity(context, { createEffect, env = process.env, createReporter = createHerdrReporter }) {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) return
  let stopped = false
  const onError = (error) => {
    if (stopped) return
    context.ui.toast.show({
      variant: "warning",
      message: `Herdr activity unavailable; reload the CLI plugin: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  let controller
  const reporter = createReporter({
    paneID: env.HERDR_PANE_ID, socketPath: env.HERDR_SOCKET_PATH,
    onError: (error) => controller.disconnect(error),
  })
  controller = createHerdrActivityController({ client: context.client, reporter, onError })
  const stream = new AbortController()
  void (async () => {
    try {
      for await (const event of context.client.event.subscribe({ signal: stream.signal })) {
        // Do not await hydration: lifecycle events must continue buffering during API reads.
        void controller.event(event)
      }
      if (!stopped) controller.disconnect(new Error("OpenCode event stream ended"))
    } catch (error) {
      if (!stopped) controller.disconnect(error)
    }
  })()
  const removeSlot = context.ui.slot({
    append: "app",
    render() {
      createEffect(() => {
        const route = context.ui.router.current()
        void controller.select(route.type === "session" ? route.sessionID : undefined)
      })
      return null
    },
  })
  const cleanup = () => {
    if (stopped) return
    stopped = true
    stream.abort()
    controller.stop()
    removeSlot()
    context.renderer.off("destroy", cleanup)
    return reporter.flush()
  }
  context.renderer.on("destroy", cleanup)
  return cleanup
}
