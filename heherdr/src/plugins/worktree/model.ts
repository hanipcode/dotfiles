const matchRank = (branch: string, query: string): number => {
  const value = branch.toLowerCase()
  if (value === query) return 0
  if (value.startsWith(query)) return 1
  return value.includes(query) ? 2 : Number.POSITIVE_INFINITY
}

export const filterBranches = (
  branches: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> => {
  const normalizedQuery = query.trim().toLowerCase().replace(/^\/+/, "")
  if (normalizedQuery === "") return branches

  return branches
    .map((branch, index) => ({ branch, index, rank: matchRank(branch, normalizedQuery) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ branch }) => branch)
}
