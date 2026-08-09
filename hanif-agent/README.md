# hanif-agent

Personal agent workflows backed by OpenCode.

```sh
hanif-agent review
hanif-agent review --base main
hanif-agent review --repo ~/Projects/example --json
```

The review command compares the merge base with the current effective worktree
and groups large changes into bounded semantic units. One combined Luna reviewer
checks each unit for local correctness, security, documentation, and applicable
standards. One holistic Sol reviewer then adjudicates Luna's engineering findings
and performs deeper cross-domain, architectural, lifecycle, compatibility, goal,
and security review. Documentation and repository-standard findings are final
after Luna and are never sent to Sol. Repository standards are
discovered from inert copies of the target base revision's tracked guidance, so
root review files and linked playbooks work from the main checkout or a Git
worktree without activating repository agent configuration.

A paste-ready Markdown report is copied to the macOS clipboard after every
successful run. Compact stage and safe tool activity is streamed to stderr while
the review runs, keeping final output and `--json` on stdout. The terminal,
Markdown, and JSON outputs include the total USD
cost and prompt-cache percentage for the run. Completed results are retained as
append-only JSONL under `/tmp/agentic-review` and reused by later runs on the same
repository branch. Immutable source snapshots and review context exist only while
a review is running and are removed afterward.
