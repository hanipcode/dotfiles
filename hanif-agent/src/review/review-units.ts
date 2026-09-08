const targetPatchLines = 1_200
const targetPatchBytes = 64 * 1_024
const targetPathCount = 12

/** Complete patch text for one changed repository path. */
export interface ReviewPatchFile {
  readonly path: string
  readonly patch: string
}

/** In-memory semantic review unit before its inert patch is written. */
export interface PlannedReviewUnit {
  readonly id: string
  readonly label: string
  readonly paths: ReadonlyArray<string>
  readonly patch: string
  readonly patchLines: number
  readonly patchBytes: number
}

interface PatchChunk extends ReviewPatchFile {
  readonly domain: string
  readonly island: string
  readonly logicalFile: string
}

interface UnitAccumulator {
  readonly chunks: ReadonlyArray<PatchChunk>
  readonly paths: ReadonlySet<string>
  readonly islands: ReadonlySet<string>
  readonly patchLines: number
  readonly patchBytes: number
}

const patchLines = (patch: string): number => {
  if (patch.length === 0) return 0
  const lines = patch.split("\n")
  const changed = lines.filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  ).length
  return changed === 0 ? lines.length : changed
}

const semanticIsland = (path: string): string => {
  const segments = path.split("/")
  const [first, second, third, fourth] = segments
  if (first === undefined) return "repository"
  if (second === undefined) return "repository"
  if (first === "packages" || first === "apps" || first === "services" || first === "crates") {
    if ((third === "src" || third === "test" || third === "tests") && fourth !== undefined) {
      return segments.length === 4
        ? [first, second, third].join("/")
        : [first, second, third, fourth].join("/")
    }
    return [first, second].join("/")
  }
  if (first === "src" && second !== undefined) return [first, second].join("/")
  return first
}

const semanticDomain = (path: string): string => {
  const segments = path.split("/")
  const [first, second] = segments
  if (first === undefined || second === undefined) return "repository"
  if (first === "packages" || first === "apps" || first === "services" || first === "crates") {
    return [first, second].join("/")
  }
  if (first === "src" || first === "test" || first === "tests" || first === "__tests__") return "application"
  return first
}

const logicalFile = (path: string): string =>
  path
    .replace(/(^|\/)(?:src|test|tests|__tests__)\//g, "$1")
    .replace(/\.(?:test|spec)(?=\.[^.]+$)/, "")

const withinTarget = (patch: string): boolean =>
  patchLines(patch) <= targetPatchLines && Buffer.byteLength(patch) <= targetPatchBytes

const splitLineByBytes = (line: string, maximumBytes: number): ReadonlyArray<string> => {
  const fragments: Array<string> = []
  let characters: Array<string> = []
  let bytes = 0
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character)
    if (characters.length > 0 && bytes + characterBytes > maximumBytes) {
      fragments.push(characters.join(""))
      characters = []
      bytes = 0
    }
    characters.push(character)
    bytes += characterBytes
  }
  if (characters.length > 0) fragments.push(characters.join(""))
  return fragments
}

const splitLines = (
  path: string,
  prefix: ReadonlyArray<string>,
  lines: ReadonlyArray<string>,
): ReadonlyArray<ReviewPatchFile> => {
  const parts: Array<ReviewPatchFile> = []
  let current: Array<string> = []
  const prefixBytes = Buffer.byteLength(prefix.join("\n")) + (prefix.length === 0 ? 0 : 1)
  const maximumLineBytes = Math.max(1, targetPatchBytes - prefixBytes)
  for (const line of lines) {
    const candidate = [...prefix, ...current, line].join("\n")
    if (current.length > 0 && !withinTarget(candidate)) {
      parts.push({ path, patch: [...prefix, ...current].join("\n") })
      current = []
    }
    if (!withinTarget([...prefix, line].join("\n"))) {
      parts.push(...splitLineByBytes(line, maximumLineBytes).map((fragment) => ({
        path,
        patch: [...prefix, fragment].join("\n"),
      })))
      continue
    }
    current.push(line)
  }
  if (current.length > 0) parts.push({ path, patch: [...prefix, ...current].join("\n") })
  return parts
}

const splitLargePatch = (file: ReviewPatchFile): ReadonlyArray<ReviewPatchFile> => {
  if (withinTarget(file.patch)) return [file]
  const lines = file.patch.split("\n")
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "))
  if (firstHunk === -1) return splitLines(file.path, [], lines)
  const header = lines.slice(0, firstHunk)
  const hunks: Array<Array<string>> = []
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@ ")) hunks.push([line])
    else hunks.at(-1)?.push(line)
  }
  const parts: Array<ReviewPatchFile> = []
  let currentHunks: Array<Array<string>> = []
  for (const hunk of hunks) {
    const candidate = [...header, ...currentHunks.flat(), ...hunk].join("\n")
    if (currentHunks.length > 0 && !withinTarget(candidate)) {
      parts.push({ path: file.path, patch: [...header, ...currentHunks.flat()].join("\n") })
      currentHunks = []
    }
    const singleHunk = [...header, ...hunk].join("\n")
    if (!withinTarget(singleHunk)) {
      const hunkHeader = hunk[0]
      if (hunkHeader !== undefined) parts.push(...splitLines(file.path, [...header, hunkHeader], hunk.slice(1)))
      continue
    }
    currentHunks.push(hunk)
  }
  if (currentHunks.length > 0) {
    parts.push({ path: file.path, patch: [...header, ...currentHunks.flat()].join("\n") })
  }
  return parts
}

const emptyUnit = (): UnitAccumulator => ({
  chunks: [],
  paths: new Set(),
  islands: new Set(),
  patchLines: 0,
  patchBytes: 0,
})

const canAdd = (unit: UnitAccumulator, chunks: ReadonlyArray<PatchChunk>): boolean => {
  const paths = new Set([...unit.paths, ...chunks.map((chunk) => chunk.path)])
  const lines = unit.patchLines + chunks.reduce((total, chunk) => total + patchLines(chunk.patch), 0)
  const bytes = unit.patchBytes + chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.patch), 0)
  return paths.size <= targetPathCount && lines <= targetPatchLines && bytes <= targetPatchBytes
}

const add = (unit: UnitAccumulator, chunks: ReadonlyArray<PatchChunk>): UnitAccumulator => ({
  chunks: [...unit.chunks, ...chunks],
  paths: new Set([...unit.paths, ...chunks.map((chunk) => chunk.path)]),
  islands: new Set([...unit.islands, ...chunks.map((chunk) => chunk.island)]),
  patchLines: unit.patchLines + chunks.reduce((total, chunk) => total + patchLines(chunk.patch), 0),
  patchBytes: unit.patchBytes + chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.patch), 0),
})

const unitLabel = (islands: ReadonlySet<string>): string => {
  const values = [...islands]
  const first = values[0]
  if (first === undefined) return "complete change"
  return values.length === 1 ? first : `${first} + ${values.length - 1} areas`
}

/** Group changed paths into bounded units without breaking small semantic file families. */
export function planReviewUnits(files: ReadonlyArray<ReviewPatchFile>): ReadonlyArray<PlannedReviewUnit> {
  if (files.length === 0) return []
  const totalPatch = files.map((file) => file.patch).join("\n")
  if (
    files.length <= targetPathCount &&
    patchLines(totalPatch) <= targetPatchLines &&
    Buffer.byteLength(totalPatch) <= targetPatchBytes
  ) {
    return [{
      id: "unit-001",
      label: "complete change",
      paths: files.map((file) => file.path).sort(),
      patch: totalPatch,
      patchLines: patchLines(totalPatch),
      patchBytes: Buffer.byteLength(totalPatch),
    }]
  }

  const chunks = files.flatMap(splitLargePatch).map((file): PatchChunk => ({
    ...file,
    domain: semanticDomain(file.path),
    island: semanticIsland(file.path),
    logicalFile: logicalFile(file.path),
  }))
  const families = new Map<string, Array<PatchChunk>>()
  for (const chunk of chunks) {
    const key = chunk.logicalFile
    const family = families.get(key) ?? []
    family.push(chunk)
    families.set(key, family)
  }

  const orderedFamilies = [...families.values()].sort((left, right) => {
    const leftPath = left[0]?.path ?? ""
    const rightPath = right[0]?.path ?? ""
    return leftPath.localeCompare(rightPath)
  })
  const familiesByDomain = new Map<string, Array<ReadonlyArray<PatchChunk>>>()
  for (const family of orderedFamilies) {
    const domain = family[0]?.domain ?? "repository"
    const domainFamilies = familiesByDomain.get(domain) ?? []
    domainFamilies.push(family)
    familiesByDomain.set(domain, domainFamilies)
  }
  const units: Array<UnitAccumulator> = []
  for (const domainFamilies of familiesByDomain.values()) {
    let current = emptyUnit()
    for (const family of domainFamilies) {
      if (current.chunks.length > 0 && !canAdd(current, family)) {
        units.push(current)
        current = emptyUnit()
      }
      if (canAdd(current, family)) {
        current = add(current, family)
        continue
      }
      for (const chunk of family) {
        if (current.chunks.length > 0 && !canAdd(current, [chunk])) {
          units.push(current)
          current = emptyUnit()
        }
        current = add(current, [chunk])
      }
    }
    if (current.chunks.length > 0) units.push(current)
  }

  return units.map((unit, index) => {
    const patch = unit.chunks.map((chunk) => chunk.patch).join("\n")
    return {
      id: `unit-${String(index + 1).padStart(3, "0")}`,
      label: unitLabel(unit.islands),
      paths: [...unit.paths].sort(),
      patch,
      patchLines: patchLines(patch),
      patchBytes: Buffer.byteLength(patch),
    }
  })
}
