---
name: pr-split
description: Split a large working branch into multiple small, atomic, reviewable pull requests using git worktrees. Use when the user asks to split a PR or branch into reviewable changes.
disable-model-invocation: true
---

# PR Split Skill

Automatically split a large working branch into multiple small, atomic, reviewable PRs using git worktrees.

All deterministic operations (git, worktree management, manifest CRUD, verification, PR creation) are handled by the script. This skill file explains how to orchestrate the AI-driven parts: diff analysis, file grouping, description generation, and user interaction.

The script lives at `$HOME/.agents/skills/pr-split/pr-split.mjs`.

**CRITICAL**: Always run from the **git repo root**. Before running any script command, ensure your CWD is the repo root (use `git rev-parse --show-toplevel` if unsure). Running from a subdirectory will cause the script to fail or use wrong paths.

**Run with**: `node "$HOME/.agents/skills/pr-split/pr-split.mjs" <command> [args]`

## Directory Structure

```
{project}-pr-worktrees/
  {safe-branch}/                  ← one folder per source branch
    manifest.json                 ← scoped to this branch only
    01-{slug}/                    ← git worktree for part 1
    02-{slug}/                    ← git worktree for part 2
  {another-branch}/               ← fully independent
    manifest.json
    01-{slug}/
```

Each branch's split is fully isolated — no shared manifest, no conflicts between branches.

## Invocation

The user invokes `pr-split` or says "split my PR" or "split this branch into PRs".

| Invocation | What it does |
|---|---|
| `/pr-split` | Full flow: analyze → plan → confirm → execute → create PRs |
| `/pr-split status` | `node "$HOME/.agents/skills/pr-split/pr-split.mjs" status` |
| `/pr-split cleanup` | `node "$HOME/.agents/skills/pr-split/pr-split.mjs" cleanup` |
| `/pr-split sync` | `node "$HOME/.agents/skills/pr-split/pr-split.mjs" sync` |

For `status`, `cleanup` — just run the script command directly and display the output. No AI analysis needed.

For `sync` — see the dedicated **Sync Flow** section below.

---

## Full Flow (`/pr-split`)

### Phase 1: Analysis (deterministic)

Run these commands and read their output:

```bash
node "$HOME/.agents/skills/pr-split/pr-split.mjs" preflight
node "$HOME/.agents/skills/pr-split/pr-split.mjs" context  # or: context <base-branch>
node "$HOME/.agents/skills/pr-split/pr-split.mjs" diff     # or: diff <base-branch>
node "$HOME/.agents/skills/pr-split/pr-split.mjs" manifest
```

- `preflight` checks dependencies (git, gh). Abort if git is missing.
- `context` returns JSON with `repoName`, `currentBranch`, `baseBranch`, `safeBranch`, `branchDir`, `dirty`, `hasGh`, `hasManifest`.
- `diff` returns the full diff stat, name-status, commit log, and diff content.
- `manifest` returns existing manifest JSON or `{}`.

**Check the context output**:
- If `dirty` is true, warn the user and ask them to commit or stash first.
- If `hasManifest` is true, show the existing state and ask: start fresh or update?

### Phase 2: Split Planning (AI-driven)

This is where you analyze the diff output and group files into atomic PRs.

**Grouping principles** (in order of priority):
1. **Types/contracts first**: Shared types, interfaces, constants, enums → PR 1
2. **Utilities/hooks next**: Shared utility functions, custom hooks → PR 2
3. **Components**: UI components, grouped by feature area → PR 3+
4. **Integration/pages**: Page-level integration, routes, API calls → later PRs
5. **Config/infra**: Build config, CI changes, dependencies → separate PR
6. **Import coherence**: If file A imports from file B, and both are new/changed, they go in the same PR (unless file B is in an earlier PR that gets merged first)
7. **Size target**: Aim for <300 lines changed per PR, but don't break coherence for size

**Rules**:
- Each file appears in exactly ONE PR. No duplicates.
- Use the `--name-status` output to get the action (A/M/D) for each file.

**Present the plan as a table**:

```
Split Plan for {current-branch} (base: {base-branch})

PR 1/N [{Feature Tag}] {description}
  - src/types/referral.ts (new, +45)
  - src/contracts/referral.ts (new, +80)
  Total: +125 lines

PR 2/N [{Feature Tag}] {description}
  - src/hooks/useReferral.ts (new, +60)
  Total: +60 lines

...
```

### Phase 3: User Confirmation (AI-driven)

Present the plan and ask for confirmation. The user can:
- Approve as-is
- Move files between groups
- Merge or further split groups
- Change the feature tag or descriptions

**Do NOT proceed until the user explicitly approves.**

### Phase 4: Execution (deterministic)

Once approved, build the plan JSON and pipe it to the script.

**Naming conventions for branches**:
- Take `safeBranch` from the context output (slashes already replaced with `--`)
- Branch format: `{safeBranch}--{zero-padded-order}-{slug}`
- Slug: kebab-case, derived from the description
- Max 50 chars total for branch name

**Build the plan JSON**:

```json
{
  "baseBranch": "main",
  "featureTag": "Referral Dashboard",
  "parts": [
    {
      "order": 1,
      "slug": "types-and-contracts",
      "branch": "feat--referral-dashboard--01-types-and-contracts",
      "title": "[1/4][Referral Dashboard] add types and contracts",
      "description": "Foundation types and API contracts for referral feature",
      "files": ["src/types/referral.ts", "src/contracts/referral.ts"],
      "fileActions": {
        "src/types/referral.ts": "A",
        "src/contracts/referral.ts": "A"
      }
    }
  ]
}
```

**Save the plan**:
```bash
echo '<plan-json>' | node "$HOME/.agents/skills/pr-split/pr-split.mjs" plan-save
```

**For each part, run sequentially**:
```bash
node "$HOME/.agents/skills/pr-split/pr-split.mjs" execute <part-number>
node "$HOME/.agents/skills/pr-split/pr-split.mjs" verify <part-number>
```

- `execute` creates the worktree, checks out files, and commits.
- `verify` installs dependencies and runs typecheck.

If `verify` fails:
- Show the error output to the user.
- Ask how to proceed: adjust file grouping, fix the issue manually, or skip verification for this part.

### Phase 5: PR Creation (deterministic)

For each verified part:
```bash
node "$HOME/.agents/skills/pr-split/pr-split.mjs" create-pr <part-number>
```

This pushes the branch, creates a GitHub PR, and updates the manifest.

If `hasGh` is false (from context), skip this phase and tell the user to push and create PRs manually.

After all PRs are created, update all PR bodies with the review order section (MANDATORY):
```bash
node "$HOME/.agents/skills/pr-split/pr-split.mjs" update-all-prs
```

Then run validation (MANDATORY — must pass before done):
```bash
node "$HOME/.agents/skills/pr-split/pr-split.mjs" validate
```
If `validate` exits non-zero, fix the reported issues before proceeding. Do NOT skip this step.

Then run `node "$HOME/.agents/skills/pr-split/pr-split.mjs" status` to show the final summary.

---

## Script Commands Reference

| Command | Description |
|---|---|
| `preflight` | Check dependencies (git, gh) |
| `context [base]` | Print repo context as JSON (default base: main) |
| `diff [base]` | Print full diff info against base branch |
| `manifest` | Read current manifest JSON |
| `plan-save` | Save plan to manifest (reads JSON from stdin) |
| `execute <N>` | Create worktree and apply files for part N |
| `verify <N>` | Install deps + run typecheck in part N's worktree |
| `create-pr <N>` | Push and create GitHub PR for part N |
| `update-pr <N>` | Update GitHub PR title and body for part N |
| `push-update <N>` | Force-push rebased branch for part N |
| `status` | Show formatted status table |
| `cleanup` | Remove worktrees/branches for merged PRs |
| `update-all-prs` | Update title + body (with review order) for all open PRs |
| `validate` | Check all diff files are covered, no orphans/stale/duplicates (exit 1 on fail) |
| `sync` | Detect orphan files, stale worktrees; output SYNC_JSON |

---

## Edge Cases

1. **Re-split**: If manifest exists for current branch, ask user: start fresh or update?
2. **Dirty working tree**: Warn and ask to commit/stash first.
3. **No `gh` CLI**: Skip PR creation, create worktrees and branches only.
4. **Typecheck fails**: Report errors, let user decide next steps.
5. **Empty diff**: Inform user there are no changes to split.
6. **Files in multiple groups**: The script validates this and errors. Fix the plan before retrying.
