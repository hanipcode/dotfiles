import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const pluginDirectory = fileURLToPath(new URL("../byfungsi", import.meta.url))
const oxlint = join(dirname(fileURLToPath(import.meta.resolve("oxlint/package.json"))), "bin", "oxlint")

test("a copied dependency-free plugin reports real diagnostics and preserves per-file options", async () => {
  const temporaryRoot = join(tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, "byfungsi-cli-"))
  try {
    await cp(pluginDirectory, join(root, "tools", "byfungsi"), { recursive: true })
    await writeFile(join(root, ".oxlintrc.json"), JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "byfungsi", specifier: "./tools/byfungsi/index.mjs" }],
      rules: {
        "byfungsi/no-module-mocking": "error",
        "byfungsi/no-object-parameters": "error",
        "byfungsi/no-known-value-widening": "error",
        "byfungsi/no-runtime-typeof": "error",
        "byfungsi/require-safety-comment-for-type-assertion": "error",
        "byfungsi/no-unknown-output": "error",
      },
      overrides: [{
        files: ["guard.ts"],
        rules: { "byfungsi/no-runtime-typeof": ["error", { allowInTypeGuards: true }] },
      }],
    }))
    const badSource = [
      'import { vi as testFramework } from "vitest";',
      'testFramework.mock("./store");',
      'function outer() { type Payload = object; function consume(input: Payload) {} }',
      'const commands: Record<string, () => void> = { start() {} };',
      'const asserted = external() as User;',
      'function output(): unknown { return external(); }',
    ].join("\n")
    await writeFile(join(root, "bad.ts"), badSource)
    await writeFile(join(root, "good.ts"), [
      'type Payload = object; function consume<Payload>(input: Payload) {}',
      'if (typeof document !== "undefined") document.title;',
      'function output(): { id: string } { return { id: "a" }; }',
      'const testFramework = { mock(value: string) {} }; testFramework.mock("ordinary method");',
      '// SAFETY: The external adapter already validates this identifier.',
      'const asserted = external() as User;',
    ].join("\n"))
    const guard = 'function isString(value: unknown): value is string { return typeof value === "string"; }'
    await writeFile(join(root, "guard.ts"), guard)
    await writeFile(join(root, "strict-guard.ts"), guard)

    let output
    try {
      execFileSync(process.execPath, [oxlint, "-c", ".oxlintrc.json", "--format", "json",
        "bad.ts", "good.ts", "guard.ts", "strict-guard.ts"], { cwd: root, encoding: "utf8" })
      assert.fail("Expected the invalid source to fail lint")
    } catch (error) {
      assert.equal(error.status, 1)
      output = JSON.parse(error.stdout)
    }
    const diagnostics = output.diagnostics
    assert.equal(diagnostics.length, 6, JSON.stringify(output))
    assert.deepEqual(diagnostics.map((item) => item.code).sort(), [
      "byfungsi(no-known-value-widening)",
      "byfungsi(no-module-mocking)",
      "byfungsi(no-object-parameters)",
      "byfungsi(no-runtime-typeof)",
      "byfungsi(no-unknown-output)",
      "byfungsi(require-safety-comment-for-type-assertion)",
    ].sort())
    assert.equal(diagnostics.filter((item) => item.filename === "strict-guard.ts").length, 1)
    assert.equal(diagnostics.filter((item) => ["good.ts", "guard.ts"].includes(item.filename)).length, 0)
    assert.equal(await readFile(join(root, "bad.ts"), "utf8"), badSource)

    // Load the copied entrypoint in a separate Node process with no local node_modules.
    execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("./tools/byfungsi/index.mjs")'], { cwd: root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
