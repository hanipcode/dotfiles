import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { OpenCode, parseOpenCodeModel } from "../src/services/OpenCode.ts"

describe("OpenCode", () => {
  it("parses provider-qualified model IDs", () => {
    expect(parseOpenCodeModel("openai/gpt-5.6-luna")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    })
    expect(() => parseOpenCodeModel("gpt-5.6-luna")).toThrow("invalid OpenCode model")
  })

  it.live("aborts SDK preparation when the caller interrupts", () =>
    Effect.gen(function* () {
      const openCode = yield* OpenCode
      const result = yield* openCode.run({
        directory: process.cwd(),
        model: "openai/gpt-5.6-luna",
        prompt: "Do not answer before two minutes have passed.",
      }).pipe(
        Effect.timeout("1 millis"),
        Effect.either,
      )
      expect(result._tag).toBe("Left")
    }).pipe(Effect.provide(OpenCode.layer)),
    10_000,
  )
})
