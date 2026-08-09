export const MAX_REQUEST_FRAME_BYTES = 256 * 1024
export const MAX_RESPONSE_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_FORWARD_FRAME_BYTES = 64 * 1024

export const encodeFrame = (value: unknown, limit: number): string => {
  const frame = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(frame) > limit) {
    throw new Error(`IPC frame exceeds ${limit} bytes`)
  }
  return frame
}

export const splitUtf8 = (text: string, limit: number): ReadonlyArray<string> => {
  const bytes = Buffer.from(text)
  const parts: string[] = []
  let offset = 0
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + limit)
    while (end < bytes.length && end > offset && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
    if (end === offset) end = Math.min(bytes.length, offset + limit)
    parts.push(bytes.subarray(offset, end).toString())
    offset = end
  }
  return parts
}
