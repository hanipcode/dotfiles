import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const testPath = (filename) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename) || /(?:^|[/\\])e2e[/\\]/.test(filename)
const literalText = (node) => {
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked
  return node?.type === "Literal" && ["'", '"'].includes(node.raw?.[0]) ? node.value : undefined
}
const memberName = (node) =>
  node?.type === "MemberExpression" && !node.computed ? node.property.name : undefined

// This deliberately narrow heuristic follows kody's tautological-absence checker.
// It is a review aid, not proof that every unflagged absence assertion is useful.
const instructionalCopy = (text) => {
  const value = text.trim()
  if (!/[A-Za-z]/.test(value) || !/\s/.test(value)) return false
  if (/[<>]/.test(value) || /&[a-z]+;/i.test(value)) return false
  if (/^(?:data-|href=|action=|id=|class=|aria-|src=|style=|https?:\/\/)/.test(value)) return false
  if (/<script|javascript:|onerror=/i.test(value)) return false
  const words = value.split(/\s+/)
  return (
    words.length >= 3 ||
    (words.length === 2 && words.every((word) => /^[A-Z]/.test(word))) ||
    /[.!?…]$/.test(value)
  )
}

const skippedDirectories = new Set([
  ".git",
  ".tmp",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
])

const readCorpus = (root) => {
  const contents = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name)
      if (
        entry.isDirectory() &&
        !skippedDirectories.has(entry.name) &&
        !relative(root, filename).startsWith("e2e/playwright-report")
      )
        visit(filename)
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
        contents.push([filename, readFileSync(filename, "utf8")])
    }
  }
  visit(root)
  return contents
}

const escapedPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const withoutNegativeCopy = (source, text) =>
  source.replace(
    new RegExp(
      `\\.not\\.(?:toContain|toContainText|toHaveTextContent)\\(\\s*(["'\x60])${escapedPattern(text)}\\1`,
      "g",
    ),
    "",
  )

/** Flags retired instructional copy that occurs only in negative substring assertions. */
export const noTautologicalAbsence = {
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!testPath(filename)) return {}
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    const absent = []
    const present = []
    return {
      CallExpression(node) {
        if (!["toContain", "toContainText", "toHaveTextContent"].includes(memberName(node.callee)))
          return
        const text = literalText(node.arguments[0])
        if (text === undefined) return
        const negative = memberName(node.callee.object) === "not"
        const receiver = negative ? node.callee.object.object : node.callee.object
        if (receiver?.type !== "CallExpression" || receiver.callee?.name !== "expect") return
        if (negative) absent.push({ node, text })
        else present.push(text)
      },
      "Program:exit"() {
        const candidates = absent.filter(
          ({ node, text }) =>
            instructionalCopy(text) && !/\\[ux]/i.test(sourceCode.getText(node.arguments[0])),
        )
        if (candidates.length === 0) return
        const corpus = readCorpus(context.cwd ?? process.cwd())
        for (const { node, text } of candidates) {
          if (
            text.length >= 16 &&
            present.some((value) => value.slice(0, 16) === text.slice(0, 16))
          )
            continue
          const raw = sourceCode.getText(node.arguments[0]).slice(1, -1)
          if (
            corpus.some(([, content]) => {
              const remaining = withoutNegativeCopy(withoutNegativeCopy(content, text), raw)
              return remaining.includes(text) || remaining.includes(raw)
            })
          )
            continue
          context.report({
            node,
            message:
              "This absent copy occurs only in negative assertions. Remove retired-copy pins; test a live state transition or an injected value instead.",
          })
        }
      },
    }
  },
}

const enclosingTest = (node) => {
  let current = node.parent
  while (current) {
    if (current.type === "CallExpression") {
      let callee = current.callee
      while (callee?.type === "MemberExpression" || callee?.type === "CallExpression") {
        callee = callee.type === "MemberExpression" ? callee.object : callee.callee
      }
      if (callee?.type === "Identifier" && ["test", "it"].includes(callee.name)) return current
    }
    if (current.type === "Program") return current
    current = current.parent
  }
  return node
}

/** Flags tests whose assertions only pin literal UI copy, not mixed behavioral tests. */
export const noWordingOnlyAssertion = {
  create(context) {
    if (!testPath(context.filename ?? context.getFilename())) return {}
    const tests = new Map()
    return {
      CallExpression(node) {
        const matcher = memberName(node.callee)
        const negative = memberName(node.callee.object) === "not"
        const expectation = negative ? node.callee.object.object : node.callee.object
        if (expectation?.type !== "CallExpression" || expectation.callee?.name !== "expect") return
        const owner = enclosingTest(node)
        const group = tests.get(owner) ?? { copy: [], behavioral: false }
        tests.set(owner, group)
        if (negative) {
          group.behavioral = true
          return
        }
        let query = expectation.arguments[0]
        if (query?.type === "AwaitExpression") query = query.argument
        const textPresence =
          ["toBeTruthy", "toBeDefined", "toBeVisible", "toBeInTheDocument"].includes(matcher) &&
          query?.type === "CallExpression" &&
          /^(?:get|query|find)(?:All)?ByText$/.test(
            memberName(query.callee) ?? query.callee?.name ?? "",
          ) &&
          literalText(query.arguments[0]) !== undefined
        const textEquality =
          ((["toBe", "toEqual", "toContain"].includes(matcher) &&
            memberName(query) === "textContent") ||
            matcher === "toHaveTextContent") &&
          literalText(node.arguments[0]) !== undefined
        if (textPresence || textEquality) group.copy.push(node)
        else group.behavioral = true
      },
      "Program:exit"() {
        for (const group of tests.values()) {
          if (group.behavioral) continue
          for (const node of group.copy)
            context.report({
              node,
              message:
                "This test asserts only literal UI wording. Test behavior or structured state instead; role/name interaction queries remain supported.",
            })
        }
      },
    }
  },
}
