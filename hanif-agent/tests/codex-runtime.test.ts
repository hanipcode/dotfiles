import { describe, expect, it, vi } from "vitest"
import { Deferred, Effect, Either, Fiber, Option } from "effect"
import { resolve, join } from "node:path"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  parseCodexModel,
  parseCodexRunOutput,
  CodexRuntime,
} from "../src/review/codex-runtime.ts"

describe("Codex reviewer runtime", () => {
  it("translates OpenAI model and reasoning syntax into Codex flags", async () => {
    await expect(Effect.runPromise(parseCodexModel("luna-quality", "openai/gpt-5.6-luna#xhigh"))).resolves.toEqual({
      name: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
    })
    await expect(Effect.runPromise(parseCodexModel("sol-holistic", "gpt-5.6-sol"))).resolves.toEqual({
      name: "gpt-5.6-sol",
      reasoningEffort: "high",
    })
  })

  it("rejects unsupported providers before invoking Codex", async () => {
    const result = await Effect.runPromise(Effect.either(parseCodexModel("luna-quality", "anthropic/claude")))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ operation: "parse Codex model", retryable: false })
    }
  })

  it("parses Codex JSONL text, tool, thread, and usage records", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-ephemeral" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-1", type: "command_execution", command: "rg --files", status: "completed" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item-2", type: "agent_message", text: "review output" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 25, cache_write_input_tokens: 5, output_tokens: 20 },
      }),
    ].join("\n")

    expect(parseCodexRunOutput(output)).toEqual({
      sessionId: "thread-ephemeral",
      text: "review output",
      usage: { costUsd: 0, inputTokens: 70, cacheReadTokens: 25, cacheWriteTokens: 5 },
      error: null,
      tools: [{ name: "command_execution", input: {} }],
    })
  })

  it("accepts a completed turn after a transient stream error but retains a terminal failure", () => {
    const recovered = [
      JSON.stringify({ type: "error", message: "reconnecting" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    ].join("\n")
    expect(parseCodexRunOutput(recovered).error).toBeNull()
    expect(parseCodexRunOutput(`${recovered}\n${JSON.stringify({ type: "turn.failed", error: { message: "terminal failure" } })}`).error)
      .toBe("terminal failure")
  })

  it("streams activity before completion, classifies both timeouts, and kills each child", async () => {
    const root = await mkdtemp(join(tmpdir(), "hanif-agent-timeout-"))
    const log = join(root, "calls.jsonl")
    vi.stubEnv("HANIF_AGENT_CODEX_BIN", resolve("tests/fixtures/fake-codex"))
    vi.stubEnv("FAKE_CODEX_MODE", "timeout")
    vi.stubEnv("FAKE_CODEX_LOG", log)
    try {
      const failedAttempts: Array<number> = []
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const active = yield* Deferred.make<void>()
        const service = yield* CodexRuntime
        const runtime = yield* service.start({ directory: root, goal: null, timeoutMs: 300,
          onProgress: (event) => Effect.gen(function* () {
            if (event.type === "stage_activity") yield* Deferred.succeed(active, undefined)
            if (event.type === "attempt_failed") failedAttempts.push(event.attempt)
          }),
        })
        const fiber = yield* runtime.run({ role: "luna-standards-modules", model: "gpt-5.6-luna",
          system: "", prompt: "Act only as the standards-modules specialist", allowTracker: false }).pipe(Effect.either, Effect.forkScoped)
        yield* Deferred.await(active)
        expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true)
        return yield* Fiber.join(fiber)
      })).pipe(Effect.provide(CodexRuntime.layer)))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toMatchObject({ kind: "timeout", attempts: 2,
        sessionId: "thread-standards-modules", message: "Reviewer timed out after 300ms" })
      expect(failedAttempts).toEqual([1, 2])
      const starts = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(starts).toHaveLength(2)
      for (const start of starts) expect(() => process.kill(start.pid, 0)).toThrow()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("interrupts a live reviewer without retrying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hanif-agent-interrupt-"))
    const log = join(root, "calls.jsonl")
    vi.stubEnv("HANIF_AGENT_CODEX_BIN", resolve("tests/fixtures/fake-codex"))
    vi.stubEnv("FAKE_CODEX_MODE", "timeout")
    vi.stubEnv("FAKE_CODEX_LOG", log)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const active = yield* Deferred.make<void>()
        const service = yield* CodexRuntime
        const runtime = yield* service.start({ directory: root, goal: null,
          onProgress: (event) => event.type === "stage_activity" ? Deferred.succeed(active, undefined).pipe(Effect.asVoid) : Effect.void })
        const fiber = yield* runtime.run({ role: "luna-standards-modules", model: "gpt-5.6-luna",
          system: "", prompt: "Act only as the standards-modules specialist", allowTracker: false }).pipe(Effect.forkScoped)
        yield* Deferred.await(active)
        yield* Fiber.interrupt(fiber)
      })).pipe(Effect.provide(CodexRuntime.layer)))
      const starts = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(starts).toHaveLength(1)
      await vi.waitFor(() => expect(() => process.kill(starts[0].pid, 0)).toThrow())
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})
