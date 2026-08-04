/**
 * `heherdr open <entrypoint>` — the bridge from a herdr keybinding to a pane.
 *
 * herdr actions and panes are separate manifest entries: an action is a plain
 * process, a pane is a terminal herdr owns. So a keybinding fires the action,
 * and the action asks herdr to open the pane. This is that indirection, shared
 * by every plugin instead of reimplemented per plugin.
 */

import { Args, Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { HerdrClient } from "./Client.ts"

const entrypoint = Args.text({ name: "entrypoint" }).pipe(
  Args.withDescription("Pane entrypoint id from herdr-plugin.toml, e.g. worktree"),
)

const placement = Args.text({ name: "placement" }).pipe(
  Args.withDescription("overlay | popup | split | tab | zoomed"),
  Args.optional,
)

export const openCommand = Command.make("open", { entrypoint, placement }).pipe(
  Command.withDescription("Open one of this plugin's panes inside herdr"),
  Command.withHandler(({ entrypoint, placement }) =>
    Effect.gen(function* () {
      const client = yield* HerdrClient

      const pluginId = process.env["HERDR_PLUGIN_ID"] ?? "heherdr"
      const where = placement._tag === "Some" ? placement.value : "overlay"

      yield* client.run([
        "plugin",
        "pane",
        "open",
        "--plugin",
        pluginId,
        "--entrypoint",
        entrypoint,
        "--placement",
        where,
        "--focus",
      ])
    }).pipe(
      Effect.catchTags({
        HerdrError: (error) => Console.error(`heherdr open: ${error.code}: ${error.message}`),
        HerdrSpawnError: (error) => Console.error(`heherdr open: ${error.reason}`),
      }),
    ),
  ),
)
