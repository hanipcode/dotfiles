import { theme } from "./theme.ts"

interface CommandListRowProps {
  readonly label: string
  readonly selected: boolean
  readonly status: string | null
}

export const commandStatusColor = (status: string): string => status === "running"
  ? theme.green
  : status === "failed"
    ? theme.red
    : status === "preparing" || status === "starting" || status === "stopping"
      ? theme.yellow
      : status === "ready"
        ? theme.blue
        : theme.overlay1

export const CommandListRow = ({ label, selected, status }: CommandListRowProps) => {
  const statusLabel = status === "preparing"
    ? "prep"
    : status === "starting"
      ? "start"
      : status === "running"
        ? "run"
        : status === "stopping"
          ? "stop"
          : status === "completed"
            ? "done"
            : status
  const badge = statusLabel === null ? "" : `[${statusLabel}]`
  return (
    <box style={{
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      gap: 1,
      overflow: "hidden",
      backgroundColor: selected ? theme.surface0 : theme.base,
    }}>
      <text wrapMode="none" truncate style={{ minWidth: 0, flexGrow: 1, fg: selected ? theme.text : theme.subtext0 }}>
        {`${selected ? ">" : " "} ${label}`}
      </text>
      <text wrapMode="none" truncate style={{ width: 9, flexShrink: 0, fg: status === null ? theme.overlay0 : commandStatusColor(status) }}>
        {badge.padStart(9)}
      </text>
    </box>
  )
}
