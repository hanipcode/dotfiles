# One-pass review and human disposition

Apply this policy to `code-review`, `hanif-agent-review`, and orchestrated pre-commit
reviews. Review is evidence for a human decision, not a loop seeking zero findings.

1. Finish implementation and the authorized focused checks. Pin the review scope
   and freeze edits while reviewers run. Run each requested review system once;
   when both are required, use the same snapshot and preserve their separate reports.
2. Analyze and show the human **all findings**, including disputed findings. Retain
   source/axis and finding IDs where available. Duplicate reports may share one
   disposition row only if every source remains traceable. For each issue provide
   impact, evidence, proposed action, and a recommended disposition:
   - **Valid:** explain the defect and proposed fix.
   - **Disputed / not applicable:** explain the counterevidence or scope decision.
   - **Deferred:** explain the remaining risk and follow-up needed.
   These are recommendations until the human accepts them, not permission to hide
   findings or let one review axis overrule another.
3. Wait for explicit human approval of fixes and dispositions. General implementation
   authorization or an orchestrator's assessment does not replace this handoff.
4. Implement only approved fixes; run affected typechecks and directly related tests
   within the existing verification permissions. Report what changed, check results,
   accepted dispositions, and remaining risks. Identify fixes as verified after review,
   not as content the original reviewers inspected.

Completion means approved fixes are verified and dispositions are recorded. There is
**no automatic post-fix review run** and no requirement to obtain zero findings.
Another review, a recovery retry, or review of newly expanded scope requires an explicit
human decision. The CLI's internal bounded retries within one invocation are unaffected.

For failed, incomplete, or mismatched-scope reviews, disclose the missing coverage and
available findings; ask whether to retry or proceed with that limitation. Never call
partial coverage a complete or clean review. A review-only request ends at the findings
handoff unless the human approves implementation.

Review or fix approval does not authorize commits, pushes, merges, deployment, lint,
builds, or broad checks. Preserve separate permissions for those operations.
