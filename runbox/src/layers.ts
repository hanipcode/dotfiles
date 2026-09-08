import { Layer } from "effect"
import { Agent } from "./services/Agent.ts"
import { GhStack } from "./services/GhStack.ts"
import { Git } from "./services/Git.ts"
import { LogStore } from "./services/LogStore.ts"
import { Metrics } from "./services/Metrics.ts"
import { Paths } from "./services/Paths.ts"
import { Project } from "./services/Project.ts"
import { Shell } from "./services/Shell.ts"
import { StateStore } from "./services/StateStore.ts"
import { Registry } from "./services/Registry.ts"
import { StorageMigration } from "./services/StorageMigration.ts"
import { PreparationMemory } from "./services/PreparationMemory.ts"
import { RepositoryCatalog } from "./services/RepositoryCatalog.ts"
import { RunboxApplication } from "./application/RunboxApplication.ts"
import { OpenCode } from "./services/OpenCode.ts"
import { Readiness } from "./services/Readiness.ts"

const InfrastructureLayer = Layer.mergeAll(Shell.layer, Paths.layer, LogStore.layer, OpenCode.layer)
const MemoryLayer = PreparationMemory.layer.pipe(Layer.provideMerge(InfrastructureLayer))

export const CoreLayer = Layer.mergeAll(
  Project.layer,
  Git.layer,
  StateStore.layer,
  Metrics.layer,
  Agent.layer,
  GhStack.layer,
  Registry.layer,
  StorageMigration.layer,
  Readiness.layer,
).pipe(Layer.provideMerge(MemoryLayer))

const CatalogLayer = RepositoryCatalog.layer.pipe(Layer.provideMerge(CoreLayer))

export const ApplicationLayer = RunboxApplication.layer.pipe(
  Layer.provideMerge(CatalogLayer),
)
