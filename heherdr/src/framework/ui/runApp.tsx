/**
 * Renderer bootstrap shared by every heherdr overlay.
 *
 * Owns the terminal lifecycle so plugin UIs never touch it: alternate screen in,
 * Kitty keyboard negotiated, renderer torn down on exit even when the UI throws.
 */

import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { RegistryProvider } from "@effect-atom/atom-react"
import { createContext, useContext, type ReactNode } from "react"
import { Data, Effect } from "effect"

/**
 * Tagged so callers can `Effect.catchTags` it. A plain `Error` in the channel
 * makes catchTags unusable — every error a plugin can see must carry a `_tag`.
 */
export class RenderError extends Data.TaggedError("RenderError")<{
  readonly reason: string
}> {}

export interface ExitApi {
  /** Tears down the renderer and resolves the `runApp` effect. */
  readonly exit: () => void
}

const ExitContext = createContext<ExitApi>({
  exit: () => {
    throw new Error("useExit() called outside of runApp()")
  },
})

/** Close the overlay from anywhere in the tree — bind it to `q` and `escape`. */
export const useExit = (): ExitApi => useContext(ExitContext)

export interface RunAppOptions {
  /**
   * `alternate-screen` restores the host pane's scrollback on exit, which is
   * what an overlay wants. Use `main-screen` for a UI meant to leave output.
   */
  readonly screenMode?: "alternate-screen" | "main-screen" | "split-footer"
  readonly useMouse?: boolean
  readonly targetFps?: number
  /**
   * Kitty keyboard negotiation. `disambiguate` (default true) is what makes
   * `escape` arrive instantly instead of needing a timeout — the difference
   * between snappy and sluggish modal switching. Pass `null` to opt out.
   */
  readonly kittyKeyboard?: {
    readonly disambiguate?: boolean
    readonly alternateKeys?: boolean
    readonly events?: boolean
    readonly reportText?: boolean
  } | null
}

export const runApp = (
  element: ReactNode,
  options: RunAppOptions = {},
): Effect.Effect<void, RenderError> =>
  Effect.async<void, RenderError>((resume) => {
    let renderer: CliRenderer | undefined
    let settled = false

    const finish = (error?: RenderError) => {
      if (settled) return
      settled = true
      try {
        renderer?.destroy()
      } catch {
        // Teardown failures must not mask the real outcome.
      }
      resume(error ? Effect.fail(error) : Effect.void)
    }

    void (async () => {
      try {
        renderer = await createCliRenderer({
          screenMode: options.screenMode ?? "alternate-screen",
          useMouse: options.useMouse ?? false,
          targetFps: options.targetFps ?? 30,
          // We handle ctrl+c ourselves: with Kitty disambiguation it arrives as
          // a key event, and a half-finished git operation should not be killed
          // mid-flight by the default handler.
          exitOnCtrlC: false,
          useKittyKeyboard:
            options.kittyKeyboard === null
              ? null
              : { disambiguate: true, alternateKeys: true, ...options.kittyKeyboard },
        })

        createRoot(renderer).render(
          <ExitContext.Provider value={{ exit: () => finish() }}>
            <RegistryProvider>{element}</RegistryProvider>
          </ExitContext.Provider>,
        )
      } catch (cause) {
        finish(new RenderError({ reason: String(cause) }))
      }
    })()

    return Effect.sync(() => finish())
  })
