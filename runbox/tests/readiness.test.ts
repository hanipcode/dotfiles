import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, TestClock } from "effect"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readiness } from "../src/services/Readiness.ts"

describe("command readiness", () => {
  it.effect("parses only the selected script and rejects invalid configuration", () => Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "runbox-readiness-config-"))),
    (root) => Effect.gen(function* () {
      const readiness = yield* Readiness
      const path = join(root, "package.json")
      yield* Effect.promise(() => writeFile(path, JSON.stringify({ runbox: { readiness: {
        dev: { type: "log", text: "ready" }, invalid: { type: "tcp", port: 0 },
      } } })))
      expect(yield* readiness.load(path, "dev")).toEqual({ type: "log", text: "ready", timeoutMs: 30_000 })
      expect(yield* readiness.load(path, "absent")).toBeNull()
      expect(yield* Effect.either(readiness.load(path, "invalid"))).toMatchObject({ _tag: "Left", left: { code: "READINESS_CONFIG_INVALID" } })
    }).pipe(Effect.provide(Readiness.layer)),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ))
  it.effect("waits for log text and reports a typed deadline", () => Effect.gen(function* () {
    const readiness = yield* Readiness
    let text = "starting"
    const started = yield* Deferred.make<void>()
    const waiting = yield* readiness.wait({ type: "log", text: "ready", timeoutMs: 500 }, () => text).pipe(
      Effect.tap(() => Deferred.succeed(started, undefined)), Effect.fork,
    )
    yield* TestClock.adjust("100 millis")
    expect(yield* Deferred.isDone(started)).toBe(false)
    text = "server ready"
    yield* TestClock.adjust("100 millis")
    yield* Fiber.join(waiting)
    const timeout = yield* readiness.wait({ type: "log", text: "missing", timeoutMs: 200 }, () => "").pipe(Effect.either, Effect.fork)
    yield* TestClock.adjust("200 millis")
    expect(yield* Fiber.join(timeout)).toMatchObject({ _tag: "Left", left: { code: "READINESS_TIMEOUT" } })
  }).pipe(Effect.provide(Readiness.layer)))

  it.live("checks TCP and HTTP readiness against a real server", () => Effect.acquireUseRelease(
    Effect.promise(async () => {
      const server = createServer((_request, response) => { response.writeHead(204).end() })
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      return server
    }),
    (server) => Effect.gen(function* () {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Readiness fixture did not bind")
      const readiness = yield* Readiness
      yield* readiness.wait({ type: "tcp", host: "127.0.0.1", port: address.port, timeoutMs: 1000 }, () => "")
      yield* readiness.wait({ type: "http", url: `http://127.0.0.1:${address.port}/health`, timeoutMs: 1000 }, () => "")
    }).pipe(Effect.provide(Readiness.layer)),
    (server) => Effect.promise(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })),
  ))
})
