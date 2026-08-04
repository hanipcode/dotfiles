/**
 * heherdr framework — shared substrate for modal (vim-style) herdr plugins.
 *
 * Plugins import from here only; nothing below reaches into another plugin.
 */

export * as Keymap from "./modal/keymap.ts"
export { useModal, makeModeAtom, type Modal, type ModalConfig } from "./modal/useModal.ts"
export type { Binding, KeyId, KeySpec, ModeSpec } from "./modal/keymap.ts"

export * as HerdrClient from "./herdr/Client.ts"
export * as PluginContext from "./herdr/PluginContext.ts"
export * as GitClient from "./git/Client.ts"

export { runApp, useExit, type RunAppOptions, type ExitApi } from "./ui/runApp.tsx"

export { theme } from "./ui/theme.ts"
