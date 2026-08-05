import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import { createContext, useContext, type ReactNode } from "react"
import { RunboxError } from "../errors.ts"

const ExitContext = createContext<() => void>(() => {})

export const useExit = () => useContext(ExitContext)

export const runApp = (element: ReactNode): Effect.Effect<void, RunboxError> =>
  Effect.async<void, RunboxError>((resume) => {
    let renderer: CliRenderer | undefined
    let settled = false
    const finish = (error?: RunboxError) => {
      if (settled) return
      settled = true
      try {
        renderer?.destroy()
      } catch {
        // Preserve the original result when terminal cleanup fails.
      }
      resume(error === undefined ? Effect.void : Effect.fail(error))
    }

    void createCliRenderer({
      screenMode: "alternate-screen",
      useMouse: true,
      targetFps: 30,
      exitOnCtrlC: false,
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    }).then((created) => {
      renderer = created
      createRoot(created).render(
        <ExitContext.Provider value={() => finish()}>{element}</ExitContext.Provider>,
      )
    }, (cause) => finish(new RunboxError({ operation: "render TUI", message: String(cause) })))

    return Effect.sync(() => finish())
  })
