export type CycleDirection = "next" | "previous"

export const cycleWorkspaceId = (
  currentWorkspaceId: string,
  mainWorkspaceId: string,
  openWorkspaceIds: ReadonlySet<string>,
  sessionWorkspaceIds: ReadonlyArray<string>,
  direction: CycleDirection,
): string | undefined => {
  const groupWorkspaceIds = [
    ...(openWorkspaceIds.has(mainWorkspaceId) ? [mainWorkspaceId] : []),
    ...sessionWorkspaceIds.filter(
      (workspaceId) => workspaceId !== mainWorkspaceId && openWorkspaceIds.has(workspaceId),
    ),
  ]

  if (groupWorkspaceIds.length < 2) return undefined

  const currentIndex = groupWorkspaceIds.indexOf(currentWorkspaceId)
  if (currentIndex === -1) return undefined

  const offset = direction === "next" ? 1 : -1
  const targetIndex = (currentIndex + offset + groupWorkspaceIds.length) % groupWorkspaceIds.length
  return groupWorkspaceIds[targetIndex]
}
