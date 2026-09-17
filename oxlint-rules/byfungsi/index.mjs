import { noTautologicalAbsence, noWordingOnlyAssertion } from "./test-assertions.mjs"
import { noUnknownOutput, noWidenThenAssert } from "./local-type-rules.mjs"
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.mjs"
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.mjs"
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.mjs"
import { noModuleMockingRule } from "./rules/no-module-mocking.mjs"
import { noObjectParametersRule } from "./rules/no-object-parameters.mjs"
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.mjs"
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.mjs"
import { requireBlankLineBetweenMultilineConstDeclarationsRule } from "./rules/require-blank-line-between-multiline-const-declarations.mjs"
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.mjs"

/** Dependency-free Oxlint plugin; individual projects own rule enablement and overrides. */
export default {
  meta: { name: "byfungsi" },
  rules: {
    "no-tautological-absence": noTautologicalAbsence,
    "no-wording-only-assertion": noWordingOnlyAssertion,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-unknown-output": noUnknownOutput,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-widen-then-assert": noWidenThenAssert,
    "require-blank-line-between-multiline-const-declarations":
      requireBlankLineBetweenMultilineConstDeclarationsRule,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
  },
}
