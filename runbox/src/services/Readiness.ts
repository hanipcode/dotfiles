import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { connect } from "node:net"
import { RunboxError } from "../errors.ts"

const timeoutMs = Schema.Number.pipe(Schema.int(), Schema.between(1, 600_000), Schema.optionalWith({ default: () => 30_000 }))
const ReadinessCheck = Schema.Union(
  Schema.Struct({ type: Schema.Literal("http"), url: Schema.String.pipe(Schema.pattern(/^https?:\/\//)), timeoutMs }),
  Schema.Struct({ type: Schema.Literal("tcp"), host: Schema.String.pipe(Schema.optionalWith({ default: () => "127.0.0.1" })), port: Schema.Number.pipe(Schema.int(), Schema.between(1, 65535)), timeoutMs }),
  Schema.Struct({ type: Schema.Literal("log"), text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8192)), timeoutMs }),
)
type ReadinessCheck = typeof ReadinessCheck.Type
const PackageReadiness = Schema.Struct({
  runbox: Schema.optional(Schema.Struct({ readiness: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })) })),
})

/** Owns optional package readiness checks; HTTP and TCP probes are read-only and bounded. */
export class Readiness extends Context.Tag("@runbox/Readiness")<Readiness, {
  readonly load: (packageJsonPath: string, script: string) => Effect.Effect<ReadinessCheck | null, RunboxError>
  readonly wait: (check: ReadinessCheck, logText: () => string) => Effect.Effect<void, RunboxError>
}>() {
  /** Probe resources and HTTP transport are owned by this layer, not the supervisor. */
  static readonly layer = Layer.effect(Readiness, Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const load = Effect.fn("Readiness.load")(function* (packageJsonPath: string, script: string) {
      const raw = yield* Effect.tryPromise({
        try: () => readFile(packageJsonPath, "utf8").then((text): unknown => JSON.parse(text)),
        catch: () => new RunboxError({ operation: "load readiness configuration", message: "Readiness package manifest could not be read", code: "READINESS_CONFIG_INVALID", details: packageJsonPath }),
      })
      const invalidConfig = () => new RunboxError({
        operation: "parse readiness configuration",
        message: "Readiness configuration must specify an HTTP URL, TCP port, or non-empty log text and a timeout of 1–600000 milliseconds",
        code: "READINESS_CONFIG_INVALID",
        suggestion: "Correct runbox.readiness in the selected package.json.",
        details: packageJsonPath,
      })
      const config = yield* Schema.decodeUnknown(PackageReadiness)(raw).pipe(Effect.mapError(invalidConfig))
      const selected = config.runbox?.readiness?.[script]
      if (selected === undefined) return null
      return yield* Schema.decodeUnknown(ReadinessCheck)(selected).pipe(Effect.mapError(invalidConfig))
    })

    const wait = Effect.fn("Readiness.wait")(function* (check: ReadinessCheck, logText: () => string) {
      const tcp = (host: string, port: number) => Effect.async<boolean>((resume) => {
        const socket = connect({ host, port })
        socket.once("connect", () => resume(Effect.succeed(true)))
        socket.once("error", () => resume(Effect.succeed(false)))
        return Effect.sync(() => { socket.destroy() })
      })
      const probe = check.type === "http"
        ? Effect.scoped(client.get(check.url).pipe(Effect.map((response) => response.status >= 200 && response.status < 300), Effect.catchAll(() => Effect.succeed(false))))
        : check.type === "tcp" ? tcp(check.host, check.port) : Effect.sync(() => logText().includes(check.text))
      // A retry is only another observation; it never starts or repairs the command.
      yield* probe.pipe(
        Effect.timeoutOption("1 second"),
        Effect.map((result) => result._tag === "Some" && result.value),
        Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (ready) => ready }),
        Effect.timeoutFail({ duration: check.timeoutMs, onTimeout: () => new RunboxError({
          operation: "wait for command readiness",
          message: "Command readiness deadline exceeded",
          code: "READINESS_TIMEOUT",
          suggestion: "Inspect the command log and its runbox.readiness configuration before restarting.",
          retryable: true,
          details: JSON.stringify({ type: check.type, timeoutMs: check.timeoutMs }),
        }) }),
      )
    })
    return Readiness.of({ load, wait })
  })).pipe(Layer.provide(FetchHttpClient.layer))
}
