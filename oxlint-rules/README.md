# Oxlint rules

Reusable, dependency-free Oxlint JavaScript plugins for projects that should own and
commit their lint tooling. These are ordinary source files, not an npm package or an
Agent Skill.

## byfungsi

`byfungsi/` contains ten TypeScript and test-architecture rules, selectively ported
from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) or maintained as
Fungsi variants. The pinned upstream revision and local differences are recorded
in [`byfungsi/UPSTREAM.md`](byfungsi/UPSTREAM.md):

- `no-chained-type-assertions`
- `no-conditional-empty-object-spread`
- `no-known-value-widening`
- `no-module-mocking`
- `no-object-parameters`
- `no-runtime-typeof`
- `no-unknown-output`
- `no-unsafe-dictionary-type`
- `no-widen-then-assert`
- `require-safety-comment-for-type-assertion`

It also contains one autofixable layout rule developed in Fungsi:

- `require-blank-line-between-multiline-const-declarations`: inserts visual separation
  between adjacent `const` declarations when either declaration spans multiple lines.

It also contains two test-quality rules developed in Fungsi:

- `no-tautological-absence`: flags retired instructional copy found only in negative
  substring assertions, following the narrow heuristic in
  [kody's checker](https://github.com/kentcdodds/kody/blob/main/tools/oxlint/tautological-absence.js).
- `no-wording-only-assertion`: flags tests whose recognized assertions only check literal
  UI wording. Mixed behavioral tests and role/accessibility queries remain supported.

These are conservative heuristics, not a complete semantic audit. Neither rule auto-fixes
tests. The absence rule scans source files beneath the linter's working directory; it
does not flag single-word retired identifiers. Both implementations live in
`byfungsi/test-assertions.mjs`, which must be copied alongside `index.mjs`.

The plugin is plain ESM and has no runtime dependency on `@oxlint/plugins`. Its copied
`LICENSE` preserves the upstream MIT notice. Copy the **whole `byfungsi/` directory**:
the entrypoint imports `rules/`, `shared/`, `local-type-rules.mjs`, and
`test-assertions.mjs`. Oxlint 1.78.0 is the tested version; older versions have not
been validated.

The ported rules handle lexical aliases, generic shadowing, and dictionary contracts
without a TypeScript checker. They do not infer arbitrary imported types or cross-file
call signatures. The retained local output/widening-flow rules keep their narrower
top-level alias analysis. Precise inline object contracts remain allowed; populated
objects widened to open dictionaries do not. `satisfies` and empty accumulators remain
supported.

`no-runtime-typeof` preserves comparisons against `"undefined"` for safe existence
probes. Projects may opt into `allowInTypeGuards: true` for that rule. The assertion
rule requires a nonempty `SAFETY:` comment by default and supports a `markers` array
for an established alternative convention. It exempts `as const`, but does not prove
that a supplied safety justification is true; that remains a review concern.

## Install in a project

From the project root, copy the whole plugin and commit it:

```sh
mkdir -p tools/oxlint
cp -R ~/.dotfiles/oxlint-rules/byfungsi tools/oxlint/byfungsi
git add tools/oxlint/byfungsi
```

Do not symlink to `~/.dotfiles`. A committed copy works in CI and for collaborators who
do not have this dotfiles repository.

Register it in `.oxlintrc.json` or the equivalent `jsPlugins` section of an Oxlint
configuration:

```json
{
  "jsPlugins": [
    {
      "name": "byfungsi",
      "specifier": "./tools/oxlint/byfungsi/index.mjs"
    }
  ],
  "rules": {
    "byfungsi/no-chained-type-assertions": "error",
    "byfungsi/no-conditional-empty-object-spread": "error",
    "byfungsi/no-known-value-widening": "error",
    "byfungsi/no-module-mocking": "error",
    "byfungsi/no-object-parameters": "error",
    "byfungsi/no-runtime-typeof": "error",
    "byfungsi/no-tautological-absence": "warn",
    "byfungsi/no-wording-only-assertion": "warn",
    "byfungsi/no-unknown-output": "error",
    "byfungsi/no-unsafe-dictionary-type": "error",
    "byfungsi/no-widen-then-assert": "error",
    "byfungsi/require-blank-line-between-multiline-const-declarations": "error",
    "byfungsi/require-safety-comment-for-type-assertion": "error"
  }
}
```

Merge these fields into an existing configuration rather than replacing project-owned
plugins, rules, overrides, or lint policy.

Verify the installed plugin using the project's existing lint command, or directly:

```sh
oxlint . --no-error-on-unmatched-pattern
```

## Update a project copy

Review local project changes first. Stage an incoming whole-directory copy separately,
then compare it with the project's existing copy:

```sh
incoming=$(mktemp -d)
cp -R ~/.dotfiles/oxlint-rules/byfungsi "$incoming/byfungsi"
diff -ru tools/oxlint/byfungsi "$incoming/byfungsi"
```

Projects may intentionally enable only a subset of the rules or add overrides. Those
choices belong in each project's Oxlint configuration, not in this shared plugin.
Port the reviewed changes while preserving project customizations; do not blindly
overwrite them. Older single-file installations need the new dependency files as well
as the updated entrypoint. No rules are enabled merely by updating the plugin files.

## Verify changes to this shared plugin

From `~/.dotfiles/oxlint-rules`:

```sh
bun install --frozen-lockfile
bun run test
```

Oxlint is a pinned **development-only** dependency for its RuleTester and a real CLI
integration test. Test suites exercise the public `byfungsi` entrypoint, including
upstream rejection/acceptance examples, local policy differences, and a standalone
copy with per-file rule options. No runtime packages need to be copied into projects.
