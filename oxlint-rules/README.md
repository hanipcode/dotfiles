# Oxlint rules

Reusable, dependency-free Oxlint JavaScript plugins for projects that should own and
commit their lint tooling. These are ordinary source files, not an npm package or an
Agent Skill.

## byfungsi

`byfungsi/` contains eight opinionated rules derived from
[`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop):

- `no-chained-type-assertions`
- `no-conditional-empty-object-spread`
- `no-known-value-widening`
- `no-object-parameters`
- `no-runtime-typeof`
- `no-unknown-output`
- `no-unsafe-dictionary-type`
- `no-widen-then-assert`

The plugin is plain ESM and has no runtime dependency on `@oxlint/plugins`. Its copied
`LICENSE` preserves the upstream MIT notice.

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
    "byfungsi/no-object-parameters": "error",
    "byfungsi/no-runtime-typeof": "error",
    "byfungsi/no-unknown-output": "error",
    "byfungsi/no-unsafe-dictionary-type": "error",
    "byfungsi/no-widen-then-assert": "error"
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

Review local project changes first. If the destination is still an unmodified copy,
update its files from the project root:

```sh
cp ~/.dotfiles/oxlint-rules/byfungsi/index.mjs tools/oxlint/byfungsi/index.mjs
cp ~/.dotfiles/oxlint-rules/byfungsi/LICENSE tools/oxlint/byfungsi/LICENSE
git diff -- tools/oxlint/byfungsi
```

Projects may intentionally enable only a subset of the rules or add overrides. Those
choices belong in each project's Oxlint configuration, not in this shared plugin.
