import { Effect, Runtime } from "effect"
import { RunboxApplication } from "../application/RunboxApplication.ts"
import { toErrorInfo } from "../errors.ts"
import { Git } from "../services/Git.ts"
import { Paths } from "../services/Paths.ts"
import { StateStore } from "../services/StateStore.ts"
import { StorageMigration } from "../services/StorageMigration.ts"
import { Shell } from "../services/Shell.ts"
import { GlobalDashboard } from "./GlobalDashboard.tsx"
import { runApp } from "./runApp.tsx"
import type { InspectionQuery } from "../application/model.ts"
import type { OperatorIntent } from "../application/model.ts"

interface GlobalDashboardOptions {
  readonly query?: InspectionQuery
  readonly initialIntent?: OperatorIntent
}

export const openGlobalDashboard = Effect.fn("Ui.openGlobalDashboard")(function* (options: GlobalDashboardOptions = {}) {
  const application = yield* RunboxApplication
  const runtime = yield* Effect.runtime<Git | Paths | Shell | StateStore | StorageMigration>()
  const runPromise = Runtime.runPromise(runtime)
  const inventory = yield* application.inspect()
  const repositoryId = options.query?.repositoryId ?? inventory.repositories[0]?.repoId
  const initial = repositoryId === undefined
    ? inventory
    : yield* application.inspect({ ...options.query, repositoryId })
  const result = <A, E, R extends Git | Paths | Shell | StateStore | StorageMigration>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    runPromise(effect.pipe(Effect.either)).then((either) => {
      if (either._tag === "Right") return either.right
      const info = toErrorInfo(either.left)
      return Promise.reject(`${info.code}: ${info.message}${info.suggestion === "" ? "" : `\n${info.suggestion}`}`)
    })
  yield* runApp(
    <GlobalDashboard
      initial={initial}
      {...(options.initialIntent === undefined ? {} : { initialIntent: options.initialIntent })}
      onInspect={(query) => result(application.inspect(query))}
      onPlan={(intent) => result(application.plan(intent))}
      onCommit={(request) => result(application.commit(request))}
      onExecute={(plan) => result(application.execute(plan))}
    />,
  )
})
