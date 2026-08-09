#!/usr/bin/env bun
/**
 * heherdr — single entrypoint for every plugin in this repo.
 *
 * One binary, one subcommand per plugin:
 *   heherdr worktree
 *   heherdr <next-plugin>
 *
 * herdr's manifest points its panes and actions at these subcommands, so adding
 * a plugin means adding a Command here plus an entry in herdr-plugin.toml — no
 * new install, no new plugin id, no duplicated bootstrap.
 */

import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { GhStackClient, GitClient, HerdrClient, PluginContext } from "@heherdr/framework"
import { openCommand } from "../src/framework/herdr/openPane.ts"
import { worktreeCommand, worktreeFromCommand } from "../src/plugins/worktree/command.tsx"
import { stackCommand } from "../src/plugins/stack/command.tsx"

const heherdr = Command.make("heherdr").pipe(
  Command.withDescription("Modal herdr plugins — vim-style overlays for herdr"),
  Command.withSubcommands([worktreeCommand, worktreeFromCommand, stackCommand, openCommand]),
)

const cli = Command.run(heherdr, {
  name: "heherdr",
  version: "0.1.0",
})

/**
 * Services every plugin can assume are present. Merged with BunContext into a
 * single layer and provided once: chaining two `Effect.provide` calls trips a
 * variance error against @effect/cli's environment type.
 */
const AppLayer = Layer.mergeAll(
  HerdrClient.layer,
  GitClient.layer,
  GhStackClient.layer,
  PluginContext.layer,
  BunContext.layer,
)

cli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain)
