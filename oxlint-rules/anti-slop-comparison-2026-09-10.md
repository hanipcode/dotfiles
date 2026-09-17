# Anti-slop comparison — 2026-09-10

## Scope and provenance

Compared upstream **c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b**, whose commit timestamp is 2026-09-10T13:53:24Z, with the current local working tree. This is source inspection, not a lint execution or a live Luna evaluation. No rule implementation or configuration was changed during this comparison.

Upstream has 18 generic rules and 5 optional Effect rules. Local `byfungsi` exports 8 derived TypeScript rules plus 2 in-progress Fungsi test-quality rules. Luna separately applies 19 Effect rules and the new circular-expectation/implementation-mirroring policy. Availability in this shared plugin or a skill is not proof that a downstream project has enabled the corresponding lint rule.

Sources: [upstream revision](https://github.com/dmmulroy/anti-slop/commit/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b), [generic exports](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/index.ts), [Effect exports](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/effect/index.ts), local `byfungsi/index.mjs:528-542`, `../hanif-agent/src/review/effect-slopcop.ts`, and `../hanif-agent/src/review/test-oracle.ts`.

The local README attributes the derived rules to upstream but records no original revision. Therefore this is a current-state comparison, not a claim that every difference was introduced after our original copy. Existing uncommitted changes to the local test-quality lint rules were preserved.

## Recent upstream changes

- September 8: [array performance rules and safe vendored upgrade guidance](https://github.com/dmmulroy/anti-slop/commit/95a56e5d24).
- September 9, merged September 10: [autofixable readable spacing](https://github.com/dmmulroy/anti-slop/commit/5a4b759644).
- September 10: [tagged-value conventions](https://github.com/dmmulroy/anti-slop/commit/01b8f46979) and [Match for literal branches](https://github.com/dmmulroy/anti-slop/commit/e6676e8d0b).
- Earlier, August 31: [scoped/generic alias fixes](https://github.com/dmmulroy/anti-slop/commit/298c993f9e) and [third-party/boundary refinements](https://github.com/dmmulroy/anti-slop/commit/f2a8e0b9a4). These matter to our simpler implementation even though they are not this week's additions.

## Existing-rule differences worth addressing first

### 1. Lexical type aliases and generic shadowing

Local `byfungsi/index.mjs:14-35` collects only non-generic top-level aliases into a name map. It does not resolve block-scoped aliases or generic substitutions and can incorrectly resolve a generic parameter against a same-named top-level alias.

Examples inferred from the local source:

```ts
// Local no-object-parameters can incorrectly resolve this generic Payload to object.
type Payload = object;
function consume<Payload>(value: Payload) {}

// Local alias collection misses the nested alias.
function outer() {
  type Payload = object;
  function consume(value: Payload) {}
}
```

Upstream explicitly tests both generic shadowing and nested/forward aliases, and resolves transparent generic aliases such as `Identity<object>`.

Sources: [alias resolver](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/shared/type-alias-resolution.ts), [object-parameter tests](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-object-parameters.test.ts). Recommendation: port lexical-resolution fixes and regression cases before adding more alias-dependent rules.

### 2. Known-value widening misses open dictionaries with safe values

Local `broadTypeKind` (`byfungsi/index.mjs:111-123`) recognizes unsafe dictionary values, but not every open dictionary. Consequently `const handlers: Record<string, Handler> = { start: handler }` is not recognized as losing the known `start` key when `Handler` itself is precise. Local visitors (`282-326`) also omit assignment expressions and calls to local unknown-input predicates.

Upstream tests these cases while allowing empty dictionary accumulators, finite-key records, `satisfies`, and named owner contracts. It additionally rejects anonymous object targets; that part is a policy choice, not just an implementation fix, because our TypeScript standards allow concise inline return contracts.

Sources: [upstream widening tests](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-known-value-widening.test.ts), local `../home/.agents/skills/coding-standards/references/typescript-safety.md:26`. Recommendation: improve open-dictionary and flow coverage, but review anonymous-object restrictions separately.

### 3. Runtime typeof has no safe existence-probe exception locally

Local `byfungsi/index.mjs:512-526` reports every runtime `typeof`. Upstream allows comparisons against the string `"undefined"`, including environment-existence probes, and offers an opt-in `allowInTypeGuards` setting.

Source: [upstream implementation](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-runtime-typeof.ts). Recommendation: preserve safe environment probes; decide separately whether to permit type-guard bodies.

### 4. Dictionary analysis differs on constraints and semantic equivalents

Local `byfungsi/index.mjs:37-109,174-202` does not distinguish generic constraints from concrete dictionary contracts and treats built-in names syntactically. It can report `T extends Record<string, unknown>` and imported/local types named `Record`; upstream tests these as valid. Conversely, upstream covers empty interfaces, transparent wrappers, semantic intersections, and interfaces with index signatures beyond our current checks.

Source: [upstream dictionary tests](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-unsafe-dictionary-type.test.ts). Recommendation: port with explicit local policy decisions about constraints; do not infer that every upstream exemption should bypass our separate unknown allowlist.

### 5. Const-only assertion chains and omission semantics

Local chained-assertion logic (`byfungsi/index.mjs:430-451`) reports any chain of two assertions; upstream exempts const-only chains and handles parenthesized outermost-report deduplication. This aligns with our generic TypeScript guidance that `as const` is ordinary, although the separate Effect review policy deliberately scrutinizes it more closely.

Local conditional-spread diagnostics (`490-510`) suggest assigning the optional property explicitly. That wording can encourage replacing omission with an own property whose value is undefined. Upstream explicitly preserves omission and provides no autofix. Recommendation: clarify the local diagnostic rather than suggesting a semantically different replacement.

Sources: [assertion rule](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-chained-type-assertions.ts), [spread rule](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-conditional-empty-object-spread.ts).

## Upstream rules without an exact local plugin counterpart

| Upstream rule/group | Existing local coverage | Recommendation |
| --- | --- | --- |
| `no-module-mocking` | Explicitly forbidden in coding-standards testing guidance, but absent from byfungsi exports. | Strong candidate for deterministic enforcement of existing policy. Upstream resolves Vitest/Jest imports and shadowing, not just identifier spelling. |
| `require-safety-comment-for-type-assertion` | Already required by TypeScript safety guidance; no byfungsi rule. | Strong candidate. A nonempty marker is only syntactic enforcement; Luna still verifies the invariant. |
| `no-reduce-accumulator-copy` | No dedicated byfungsi rule. | Add selectively with native `oxc/no-accumulating-spread`, subject to configuration approval. It catches concat/slice/Object.assign-style copies that spread-only checks miss. |
| `no-array-filter-map` | No dedicated byfungsi rule. | Optional suggestion, not an automatic performance defect. Iterator support, callback order, indexes, and sparse arrays matter; upstream has no autofix. |
| `no-reflect-get`, `no-reflect-apply` | Broad typed-boundary guidance, not exact lint rules. | Consider only after auditing legitimate adapter/tooling uses. |
| `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases` | Our default unknown ban/explicit file allowlist plus custom `no-unknown-output`. | Preserve our ownership policy rather than replacing it wholesale. |
| `no-shape-in-symbol-names` | No equivalent blanket spelling ban. | Skip unless intentionally adopted as a naming preference; even legitimate geometric/domain names would match. |
| `require-readable-spacing` | No equivalent byfungsi rule; formatting is excluded from Luna review. | Treat as optional formatting policy, not semantic review. It vendors another licensed implementation and adds maintenance surface. |

Sources: [pinned README/rule catalog](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/README.md), [module-mocking implementation](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-module-mocking.ts), [accumulator-copy implementation](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-reduce-accumulator-copy.ts), [filter/map implementation](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-array-filter-map.ts), local `../home/.agents/skills/coding-standards/references/testing.md:16-32` and `references/typescript-safety.md:28-43` in that same skill.

## Deliberate differences to retain

### Unknown ownership

Our `../home/.agents/skills/ban-unknown-with-lint/SKILL.md` calls for an ordinary-source ban, exact reviewed runtime boundary paths, and tooling/test exceptions. It explicitly says `cause: unknown` is not automatically exempt. Upstream's parameter rule exempts a parameter named `cause` and the exact subject of a type predicate. Those are different policies.

Our `no-unknown-output` inspects nested annotations on returns, properties, and exported bindings (`byfungsi/index.mjs:328-425`); upstream's return and alias rules are not a drop-in replacement for that surface. Do not replace the local rule merely because upstream now has similarly named checks.

Source: [upstream parameter rule](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/rules/no-unknown-parameters.ts).

### Effect: mostly an enforcement gap, not a missing policy

| Upstream Effect rule | Luna overlap in `effect-slopcop.ts` |
| --- | --- |
| `no-manual-effect-error-tag` | Rules 5–7: no direct tag dispatch, typed selective recovery. |
| `no-manual-tag-comparison` | Rules 2 and 5: model-owned matching/predicates. |
| `no-manual-tagged-construction` | Rule 15: schema-owned tags/constructors. |
| `prefer-effect-match` | Rules 2–4: schema-modeled domains and exhaustive matching. |
| `no-service-constructor-imports` | Rule 19: meaningful construction/composition ownership. |

Upstream permits general Match and Data constructors that do not fully express our schema-first policy. Its service rule matches any named relative import beginning `make` followed by an uppercase letter outside test/spec filenames; it does not establish that the import is actually a dependency-bearing Effect service. Blind adoption can reject legitimate smart constructors or composition-root wiring. Our reviewer traces ownership and the pinned Effect version instead.

Sources: local `../hanif-agent/src/review/effect-slopcop.ts:8-26`, [upstream Effect catalog](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/README.md#effect-rules), [constructor-import implementation](https://github.com/dmmulroy/anti-slop/blob/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src/effect/rules/no-service-constructor-imports.ts).

### Test quality remains our additional coverage

Neither upstream entry point exports semantic tautology or implementation-mirroring rules. Keep Luna's `test-oracle/circular-expectation` and `test-oracle/implementation-mirroring`. The local working tree also contains `no-tautological-absence` and `no-wording-only-assertion`, explicitly described as narrow, non-autofixing heuristics in `README.md:21-32`; their presence does not replace the semantic review.

## Recommended order

1. Port correctness/precision improvements to existing rules, with upstream positive/negative regression cases: scope, aliases, known-value flows, safe typeof probes, dictionary constraints, and omission diagnostics.
2. Add module-mocking and safety-comment enforcement because these already match documented policy.
3. Consider accumulator-copy checks; decide separately on filter/map style and optional Effect lint enforcement.
4. Preserve the local unknown ownership policy, custom output coverage, semantic test review, and deliberate Effect differences.
5. Record a pinned upstream revision and local deviations for future updates. Upstream is vendored TypeScript using `@oxlint/plugins`; ours is dependency-free ESM. This is a reviewed port, not a safe wholesale file replacement.

All lint configuration and enablement changes require explicit approval. No packages were installed, no lint configuration changed, and no rule tests were run for this comparison. The only added artifact is this report.
