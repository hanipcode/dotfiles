#!/usr/bin/env bun

import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { runDaemon } from "../src/daemon.ts"
import { RunboxError } from "../src/errors.ts"
import { CoreLayer } from "../src/layers.ts"
import { Paths } from "../src/services/Paths.ts"
import { Project } from "../src/services/Project.ts"
import { StateStore } from "../src/services/StateStore.ts"

const repoRoot = process.argv[2]

const program = Effect.gen(function* () {
  if (repoRoot === undefined) {
    return yield* new RunboxError({
      operation: "start daemon",
      message: "missing repository path",
      code: "INVALID_REQUEST",
      suggestion: "The daemon is internal; start it through a normal runbox command.",
    })
  }
  const projects = yield* Project
  const store = yield* StateStore
  const paths = yield* Paths
  const project = yield* projects.discover(repoRoot)
  const state = yield* store.load(project)
  return yield* runDaemon(project, state, paths.socket(project.repoId))
})

const AppLayer = Layer.merge(CoreLayer, BunContext.layer)

program.pipe(Effect.provide(AppLayer), BunRuntime.runMain)
