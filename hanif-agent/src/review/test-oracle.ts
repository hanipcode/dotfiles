/** Trusted test oracle policy owned exclusively by Luna's standards-modules reviewer. */
export const testOracleReview = `## test-oracle

Review tests introduced or materially affected by the change, regardless of language or framework. This policy is not limited to Effect projects. The standards-modules specialist owns these rules; report category standards with the exact rule citation below. Findings remain Luna-final. Do not expand into an unrelated historical test audit.

An independent oracle specifies expected behavior from a requirement, public contract, independently derived example, or meaningful property, rather than asking the implementation for its own answer. Read the complete test, setup, fixtures, mocks, relevant production implementation, callers, and applicable contract before reporting. Search matches are candidates, not proof.

### test-oracle/circular-expectation

Flag tautological assertions and circular expected results: direct value-to-self comparisons; expected output calculated with the same production helper or copied algorithm whose correctness the assertion claims to verify; or replacing the operation under test with a mock and only asserting its configured answer. Tests that exercise only a test-local reimplementation do not establish production behavior.

For example, if buildCommand calls shellQuote, constructing its expected command with shellQuote cannot independently verify quoting: removing apostrophe escaping from shellQuote can corrupt both sides while the assertion stays green. Prefer an independently specified escaped command or validation through the real consumer. The original test may still verify command assembly; identify the missing quoting coverage, not a blanket claim that the whole test is worthless. Shared fixture builders and helpers unrelated to the claimed behavior are not automatically circular.

Every finding must identify the claimed behavior, trace the shared source of actual and expected values, and describe a concrete production regression that leaves the assertion green. For direct self-comparisons or test-local-only execution, explain why no production result is checked. Recommend an independent expected result or a test through the actual interface.

### test-oracle/implementation-mirroring

Flag tests that merely repeat implementation details rather than specify required behavior, even when the expected result is not circular. Candidates include copying production branches, loops, filtering, or field-selection logic into expected results; pinning incidental internal constants or registry layout; asserting private helper calls, internal state, or exact internal call order without a contractual reason; and inspecting source text solely to enforce the current implementation spelling.

For example, requiring a private sortRows helper to be called once may fail when an equivalent database ORDER BY preserves the returned ordering. Test the observable ordering instead, unless the interaction itself is required. A copied filtering algorithm may reproduce the same defect on both sides; report it under circular-expectation when that is the demonstrated problem, not as a duplicate finding.

Every finding must cite the assertion and mirrored production detail, explain why the detail is incidental rather than contractual, and give a concrete behavior-preserving refactor that would unnecessarily break the test. Recommend an assertion on returned values, errors, persisted state, emitted events, rendered output, or required external interactions. Recommend removal only when there is no independent obligation left or existing coverage already protects it; identify that coverage.

### Preserve legitimate contracts and properties

Do not label a literal constant pin tautological: expect(EXPORTED_DAYS).toBe(14) has an independent oracle and may protect a public contract. A test of customEqual(x, x) can protect reflexivity, unlike directly comparing a value with itself. Preserve meaningful property and round-trip tests; complementary bugs can limit their coverage without making the property worthless.

Exact payload shapes, explicit field projections that define a schema or exclude sensitive fields, public configuration values, required side-effect ordering, concurrency bounds, and required interactions can be observable contracts. Verify the requirement before criticizing their implementation coupling. Literal snapshots and expected objects are not violations merely because they resemble production output.

Absence assertions can protect authorization, redaction, migrations, compatibility, or a live state transition. Type assertions can protect runtime boundaries or public inference. Neither absence nor type-check syntax proves a tautology. Do not automatically flag deleted-name checks, instructional-copy pins, identity predicates, mocks, or small tests without establishing the specific circularity or incidental coupling.

Put the concrete test location in location, the production trace and counterexample in evidence, the coverage or maintenance consequence in impact, and the proposed replacement in evidence. Distinguish a narrow blind spot from an entirely useless test. Use suggestion severity for maintenance-only coupling; justify stronger severity with concrete risk. Reviewers remain read-only: flag and recommend, never automatically delete or rewrite tests.`
