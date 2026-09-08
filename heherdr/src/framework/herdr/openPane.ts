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

const width = Args.text({ name: "width" }).pipe(
  Args.withDescription("Pane width in cells or as a percentage"),
  Args.optional,
)

const height = Args.text({ name: "height" }).pipe(
  Args.withDescription("Pane height in cells or as a percentage"),
  Args.optional,
)

export const openCommand = Command.make("open", { entrypoint, placement, width, height }).pipe(
  Command.withDescription("Open one of this plugin's panes inside herdr"),
  Command.withHandler(({ entrypoint, placement, width, height }) =>
    Effect.gen(function* () {
      const client = yield* HerdrClient

      const pluginId = process.env["HERDR_PLUGIN_ID"] ?? "heherdr"
      const where = placement._tag === "Some" ? placement.value : "overlay"

      const args = [
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
      ]
      if (width._tag === "Some") args.push("--width", width.value)
      if (height._tag === "Some") args.push("--height", height.value)

      yield* client.run(args)
    }).pipe(
      Effect.catchTags({
        HerdrError: (error) => Console.error(`heherdr open: ${error.code}: ${error.message}`),
        HerdrSpawnError: (error) => Console.error(`heherdr open: ${error.reason}`),
      }),
    ),
  ),
)
