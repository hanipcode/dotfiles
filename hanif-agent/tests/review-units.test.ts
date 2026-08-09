import { describe, expect, it } from "vitest"
import { planReviewUnits } from "../src/review/review-units.ts"

const patch = (path: string, lines: number, width = 48): string => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1 +1 @@",
  ...Array.from({ length: lines }, (_, index) => `+export const value${index} = "${"x".repeat(width)}"`),
].join("\n")

describe("semantic review units", () => {
  it("keeps a bounded change in one Luna unit", () => {
    const units = planReviewUnits([
      { path: "src/cart/cart.ts", patch: patch("src/cart/cart.ts", 20) },
      { path: "src/cart/cart.test.ts", patch: patch("src/cart/cart.test.ts", 20) },
    ])

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      id: "unit-001",
      label: "complete change",
      paths: ["src/cart/cart.test.ts", "src/cart/cart.ts"],
    })
  })

  it("covers disconnected large changes once while keeping every unit bounded", () => {
    const files = [
      { path: "packages/api/src/auth/session.ts", patch: patch("packages/api/src/auth/session.ts", 2_000) },
      { path: "packages/app/src/review/view.tsx", patch: patch("packages/app/src/review/view.tsx", 2_000) },
      { path: "packages/store/src/orders/store.ts", patch: patch("packages/store/src/orders/store.ts", 2_000) },
    ]
    const units = planReviewUnits(files)

    expect(units.length).toBeGreaterThan(1)
    expect([...new Set(units.flatMap((unit) => unit.paths))].sort()).toEqual(files.map((file) => file.path).sort())
    expect(units.every((unit) => unit.patchLines <= 4_000)).toBe(true)
    expect(units.every((unit) => unit.patchBytes <= 160 * 1_024)).toBe(true)
    expect(units.every((unit) => unit.paths.length <= 40)).toBe(true)
  })

  it("keeps a source file with its test when the family fits", () => {
    const files = [
      { path: "packages/core/src/orders/order.ts", patch: patch("packages/core/src/orders/order.ts", 800) },
      {
        path: "packages/core/tests/orders/order.test.ts",
        patch: patch("packages/core/tests/orders/order.test.ts", 800),
      },
      { path: "packages/ui/src/shell/app.tsx", patch: patch("packages/ui/src/shell/app.tsx", 3_000) },
    ]
    const units = planReviewUnits(files)
    const orderUnit = units.find((unit) => unit.paths.includes("packages/core/src/orders/order.ts"))

    expect(orderUnit?.paths).toContain("packages/core/tests/orders/order.test.ts")
  })

  it("repeats file and hunk context when one hunk must be split", () => {
    const path = "packages/core/src/large.ts"
    const units = planReviewUnits([{ path, patch: patch(path, 7_000) }])

    expect(units.length).toBeGreaterThan(1)
    expect(units.every((unit) => unit.patch.startsWith(`diff --git a/${path} b/${path}`))).toBe(true)
    expect(units.every((unit) => unit.patch.includes("@@ -1 +1 @@"))).toBe(true)
  })

  it("bounds one oversized added line", () => {
    const path = "packages/core/src/embedded-data.ts"
    const units = planReviewUnits([{ path, patch: patch(path, 1, 200_000) }])

    expect(units.length).toBeGreaterThan(1)
    expect(units.every((unit) => unit.patchBytes <= 160 * 1_024)).toBe(true)
  })
})
