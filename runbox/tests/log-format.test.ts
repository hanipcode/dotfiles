import { describe, expect, it } from "vitest"
import { formatLogOutput } from "../src/logFormat.ts"

describe("log formatting", () => {
  it("renders OpenCode text and tool progress without transport records or tool output", () => {
    const input = [
      JSON.stringify({ type: "step_start", sessionID: "session", part: { type: "step-start" } }),
      JSON.stringify({
        type: "text",
        sessionID: "session",
        part: { type: "text", text: "Installing dependencies." },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "session",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: "SECRET=do-not-render" },
        },
      }),
      JSON.stringify({ type: "step_finish", sessionID: "session", part: { type: "step-finish" } }),
    ].join("\n")

    expect(formatLogOutput(input)).toBe("Installing dependencies.\n[Luna] bash completed")
  })

  it("preserves application JSON that is not an OpenCode record", () => {
    const input = JSON.stringify({ type: "text", message: "application event" })

    expect(formatLogOutput(input)).toBe(input)
  })
})
