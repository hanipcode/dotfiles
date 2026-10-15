# Global Rules

Treat JavaScript and TypeScript lint configuration as user-owned. Do not modify ESLint, Oxlint, or Biome configuration unless the task explicitly requires it. If a change is necessary and the user has not already requested it, explain the exact change and obtain approval before editing.

Apply the same rule to lint-related settings embedded in `package.json`, including lint configuration objects and lint script options. Never disable, weaken, or ignore lint rules merely to make checks pass; fix the source code instead.

When running lint or checks, make sure to include autofix, like `pnpm exec oxlint --fix <changed-files> --max-warnings 0`.

## Worktree and background agents

Use GPT 6.1 Sol (`openai/gpt-6.1-sol` in `opencode2`) for agents working in a Git worktree or running in the background. Select this model explicitly when launching those agents.
