import { readFileSync, renameSync, writeFileSync } from "node:fs"

const directive = "-opencode.merman"

export function toggleMerman(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"))
  const plugins = Array.isArray(config.plugins) ? config.plugins : []
  const disabled = plugins.includes(directive)
  config.plugins = disabled ? plugins.filter((entry) => entry !== directive) : [...plugins, directive]

  const temporary = `${configPath}.hanip-keybind`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, configPath)
  return disabled
}

export default {
  id: "hanip.keybind",
  setup(context) {
    const configPath = "/Users/hanifmuhammad/.config/opencode/cli.json"
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "merman.toggle",
              title: "Toggle Merman diagrams",
              group: "System",
              bind: "ctrl+m",
              run() {
                try {
                  const enabled = toggleMerman(configPath)
                  context.ui.toast.show({
                    variant: "info",
                    message: `Merman diagrams ${enabled ? "enabled" : "disabled"}`,
                  })
                } catch (cause) {
                  context.ui.toast.show({
                    variant: "error",
                    message: cause instanceof Error ? cause.message : String(cause),
                  })
                }
              },
            },
          ],
        }))
        return null
      },
    })
  },
}
