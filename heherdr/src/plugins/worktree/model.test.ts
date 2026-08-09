import { describe, expect, it } from "bun:test"
import { filterBranches } from "./model.ts"

describe("filterBranches", () => {
  it("puts an exact branch match before substring matches", () => {
    expect(
      filterBranches(
        [
          "feat/XEN-4598/maintenance-detail",
          "feat/maintenance/ui",
          "main",
          "feat/maintenance-contract",
        ],
        "main",
      ),
    ).toEqual([
      "main",
      "feat/XEN-4598/maintenance-detail",
      "feat/maintenance/ui",
      "feat/maintenance-contract",
    ])
  })

  it("accepts the slash prefix used by the filter prompt", () => {
    expect(filterBranches(["feat/maintenance/ui", "main"], "/main")).toEqual([
      "main",
      "feat/maintenance/ui",
    ])
  })
})
