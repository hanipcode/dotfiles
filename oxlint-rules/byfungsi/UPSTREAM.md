# Upstream provenance and local policy

- Source: <https://github.com/dmmulroy/anti-slop>
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Revision date: 2026-09-10
- Port date: 2026-09-10
- License: MIT; the upstream notice is preserved in `LICENSE`.

This is a selected, locally owned port, not an unmodified upstream distribution.
Do not replace this directory wholesale during future updates.

## Ported files

These `rules/*.mjs` files correspond to upstream `src/rules/<same-name>.ts`:

- `no-chained-type-assertions`
- `no-conditional-empty-object-spread`
- `no-known-value-widening`
- `no-object-parameters`
- `no-runtime-typeof`
- `no-unsafe-dictionary-type`
- `no-module-mocking`
- `require-safety-comment-for-type-assertion`

`shared/*.mjs` corresponds to the same-named upstream `src/shared/*.ts`:
`dictionary-types`, `function-parameters`, `lexical-type-parameters`, `scope`,
and `type-alias-resolution`. These are the selected rules' dependency closure,
not the entire upstream helper collection.

The eight corresponding suites in `../tests/` port upstream test cases but import
the actual local plugin entrypoint. Their original `anti-slop/` suite labels are
retained for traceability; the registered project namespace remains `byfungsi`.

## Mechanical adaptations

The initial TypeScript-to-JavaScript conversion used Bun 1.3.14's Transpiler with
the TypeScript loader and Node target. Runtime `defineRule` identity wrappers and
their imports were removed, type-only imports/types were erased, relative `.ts`
imports became `.mjs`, and `createOnce(context)` became per-file `create(context)`.
Export documentation was restored after transpilation. The result has no runtime
dependency on Bun, TypeScript, or `@oxlint/plugins`.

The port uses Oxlint's lexical scope and visitor-key APIs. Tests pin Oxlint 1.78.0,
matching the source revision. Older Oxlint releases have not been validated.

## Deliberate local differences

1. **Precise inline object contracts remain valid.** The known-value-widening rule
   ignores upstream's `anonymous object` classification. Two upstream rejection
   examples were moved into valid cases: an inline object binding annotation and
   an inline object return annotation. Open dictionary widening is still rejected.
2. **Keep the existing any/empty-object widening restriction.** Dictionary target
   classification additionally handles `any` and `{}`, including aliases. Transparent
   generic aliases propagate non-dictionary broad targets too; upstream previously
   retained only the open-dictionary result in that branch. Local regression cases
   cover `Identity<unknown>`, `Identity<any>`, `Identity<object>`, and `Identity<{}>`.
3. **Keep Fungsi-owned output and widening-flow rules.** `local-type-rules.mjs`
   preserves the previous `no-unknown-output` and `no-widen-then-assert`
   implementations and their helpers from `index.mjs`, without replacing them
   with upstream's different unknown-return or widening-flow policies. Their
   existing top-level, non-generic alias-resolution limits remain; the new lexical
   resolver applies to the ported rules, not these two retained implementations.
4. **Keep the test-quality rules unchanged.** `test-assertions.mjs` remains the owner
   of `no-tautological-absence` and `no-wording-only-assertion`. Neither is an upstream
   anti-slop rule; both remain non-autofixing heuristics.
5. **Do not change unknown input ownership.** No upstream unknown-parameter/alias
   rule or automatic `cause` exemption was imported. The separately documented
   default unknown ban and reviewed boundary allowlist remain project policy.
6. **No optional rule expansion.** Performance, naming, spacing, reflection, and
   Effect plugins were not imported. Enabling any rule in downstream configuration
   remains a separate project decision.
7. **Interface evidence is lexical too.** Upstream's separate top-level interface
   name map incorrectly classified a generic parameter or inner concrete alias
   sharing an empty interface's name. The port stores declarations in the lexical
   environment and resolves only visible interfaces. Regression cases verify those
   safe uses and detection of a nested empty interface. The false-positive case was
   reproduced before this local fix.

## Verification and future updates

From `oxlint-rules/`, run `bun install --frozen-lockfile` and `bun run test`.
The CLI test copies only `byfungsi/` to a temporary project with no local
`node_modules`, verifies real diagnostics, validates per-file options, and imports
the copied plugin in a separate Node process. Local regression cases protect the
preserved output/widening rules and inline-contract differences.

For an update, retrieve a pinned upstream revision into a separate staging
directory. Compare the selected files and their upstream tests against this base,
then port reviewed changes into the locally owned JavaScript. Preserve local
deviations, tests, and the MIT notice. Record the new revision only after the
focused suites and standalone-copy CLI test pass. Do not rerun a blind copy or
transpilation over customized files, and do not enable rules in downstream lint
configuration without approval.
