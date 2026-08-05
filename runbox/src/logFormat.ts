const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const formatLine = (line: string): string | null => {
  if (!line.trimStart().startsWith("{")) return line
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return line
  }
  if (!isRecord(value) || typeof value.sessionID !== "string" || !isRecord(value.part)) {
    return line
  }
  if (value.type === "step_start" || value.type === "step_finish") return null
  if (value.type === "text" && typeof value.part.text === "string") return value.part.text
  if (value.type === "tool_use" && typeof value.part.tool === "string" && isRecord(value.part.state)) {
    const status = value.part.state.status
    return `[Luna] ${value.part.tool}${typeof status === "string" ? ` ${status}` : ""}`
  }
  return line
}

export const formatLogOutput = (input: string): string =>
  input.split("\n").flatMap((line) => {
    const formatted = formatLine(line)
    return formatted === null ? [] : [formatted]
  }).join("\n").replace(/^\n+/, "")
