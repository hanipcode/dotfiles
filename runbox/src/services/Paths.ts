import { Context, Layer } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"

const home = process.env.HOME ?? "."
const runboxHome = process.env.RUNBOX_HOME ?? join(home, ".runbox")
const legacyDataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share")
const legacyStateHome = process.env.XDG_STATE_HOME ?? join(home, ".local", "state")

export class Paths extends Context.Tag("@runbox/Paths")<
  Paths,
  {
    readonly repoData: (repoId: string) => string
    readonly repoState: (repoId: string) => string
    readonly dataRoot: string
    readonly stateRoot: string
    readonly legacyStateRoot: string
    readonly runner: (repoId: string) => string
    readonly stateFile: (repoId: string) => string
    readonly historyFile: (repoId: string) => string
    readonly instructionsFile: (repoId: string) => string
    readonly legacyRepoData: (repoId: string) => string
    readonly legacyRepoState: (repoId: string) => string
    readonly legacyRunner: (repoId: string) => string
    readonly legacyStateFile: (repoId: string) => string
    readonly socket: (repoId: string) => string
  }
>() {
  static readonly layer = Layer.succeed(
    Paths,
    Paths.of((() => {
      const stateRoot = join(runboxHome, "state")
      const dataRoot = join(runboxHome, "data")
      const legacyStateRoot = join(legacyStateHome, "runbox")
      const legacyDataRoot = join(legacyDataHome, "runbox")
      const newState = (repoId: string) => join(stateRoot, repoId)
      const oldState = (repoId: string) => join(legacyStateRoot, repoId)
      const useLegacy = (repoId: string) => !existsSync(newState(repoId)) && existsSync(oldState(repoId))
      const repoState = (repoId: string) => useLegacy(repoId) ? oldState(repoId) : newState(repoId)

      return {
        repoData: (repoId) => useLegacy(repoId) ? join(legacyDataRoot, repoId) : join(dataRoot, repoId),
        repoState,
        dataRoot,
        stateRoot,
        legacyStateRoot,
        runner: (repoId) => useLegacy(repoId)
          ? join(legacyDataRoot, repoId, "worktree")
          : join(dataRoot, repoId, "worktree"),
        stateFile: (repoId) => join(repoState(repoId), "state.json"),
        historyFile: (repoId) => join(repoState(repoId), "run-history.jsonl"),
        instructionsFile: (repoId) => join(repoState(repoId), "instructions.jsonl"),
        legacyRepoData: (repoId) => join(legacyDataRoot, repoId),
        legacyRepoState: oldState,
        legacyRunner: (repoId) => join(legacyDataRoot, repoId, "worktree"),
        legacyStateFile: (repoId) => join(oldState(repoId), "state.json"),
        socket: (repoId) => `/tmp/runbox-${process.getuid?.() ?? "user"}/${repoId}.sock`,
      }
    })()),
  )
}
