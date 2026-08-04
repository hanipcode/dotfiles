/**
 * The environment herdr hands a plugin process.
 *
 * `HERDR_PLUGIN_CONTEXT_JSON` carries the full invocation context; the discrete
 * `HERDR_*` vars are the fallback when a pane was started outside an action
 * (e.g. running `heherdr worktree` by hand in a normal pane, which is how you
 * develop these).
 */

import { Context, Effect, Layer, Option } from "effect"

export interface ContextWorktree {
  readonly repo_key: string
  readonly repo_name: string
  readonly repo_root: string
  readonly checkout_path: string
  readonly is_linked_worktree: boolean
}

/** Shape of HERDR_PLUGIN_CONTEXT_JSON (herdr's PluginInvocationContext). */
export interface InvocationContext {
  readonly workspace_id?: string
  readonly workspace_label?: string
  readonly workspace_cwd?: string
  readonly tab_id?: string
  readonly tab_label?: string
  readonly focused_pane_id?: string
  readonly focused_pane_cwd?: string
  readonly focused_pane_agent?: string
  readonly focused_pane_status?: string
  readonly worktree?: ContextWorktree
  readonly selected_text?: string
  readonly clicked_url?: string
  readonly link_handler_id?: string
  readonly invocation_source?: string
  readonly correlation_id?: string
}

export interface PluginContext {
  /** Parsed invocation context, absent when launched outside an action. */
  readonly invocation: Option.Option<InvocationContext>
  readonly workspaceId: Option.Option<string>
  readonly tabId: Option.Option<string>
  readonly paneId: Option.Option<string>
  /**
   * Best available "what project am I in": invocation workspace_cwd, then the
   * focused pane cwd, then the process cwd. Prefer this over
   * `WorkspaceInfo.worktree`, which is unreliably populated.
   */
  readonly projectDir: string
  readonly pluginId: Option.Option<string>
  /** Writable per-plugin state dir (~/.local/state/herdr/plugins/<id>). */
  readonly stateDir: Option.Option<string>
  /** User-editable config dir (~/.config/herdr/plugins/config/<id>). */
  readonly configDir: Option.Option<string>
  /** True when running inside a herdr pane at all. */
  readonly inHerdr: boolean
}

export const PluginContext = Context.GenericTag<PluginContext>("@heherdr/PluginContext")

const env = (key: string): Option.Option<string> => {
  const value = process.env[key]
  return value === undefined || value === "" ? Option.none() : Option.some(value)
}

const parseInvocation = (): Option.Option<InvocationContext> =>
  Option.flatMap(env("HERDR_PLUGIN_CONTEXT_JSON"), (raw) => {
    try {
      return Option.some(JSON.parse(raw) as InvocationContext)
    } catch {
      // A malformed context is not worth failing the whole UI over — the
      // discrete env vars and cwd fallbacks still give us a usable context.
      return Option.none()
    }
  })

const make = (): PluginContext => {
  const invocation = parseInvocation()
  const fromInvocation = <A>(f: (c: InvocationContext) => A | undefined): Option.Option<A> =>
    Option.flatMap(invocation, (c) => Option.fromNullable(f(c)))

  return {
    invocation,
    workspaceId: Option.orElse(fromInvocation((c) => c.workspace_id), () =>
      Option.orElse(env("HERDR_WORKSPACE_ID"), () => env("HERDR_ACTIVE_WORKSPACE_ID")),
    ),
    tabId: Option.orElse(fromInvocation((c) => c.tab_id), () => env("HERDR_TAB_ID")),
    paneId: Option.orElse(fromInvocation((c) => c.focused_pane_id), () => env("HERDR_PANE_ID")),
    projectDir: Option.getOrElse(
      Option.orElse(fromInvocation((c) => c.workspace_cwd), () =>
        Option.orElse(fromInvocation((c) => c.focused_pane_cwd), () =>
          env("HERDR_ACTIVE_PANE_CWD"),
        ),
      ),
      () => process.cwd(),
    ),
    pluginId: env("HERDR_PLUGIN_ID"),
    stateDir: env("HERDR_PLUGIN_STATE_DIR"),
    configDir: env("HERDR_PLUGIN_CONFIG_DIR"),
    inHerdr: Option.isSome(env("HERDR_PANE_ID")),
  }
}

export const layer = Layer.sync(PluginContext, make)

/** Convenience for handlers that only need the project directory. */
export const projectDir = Effect.map(PluginContext, (c) => c.projectDir)
