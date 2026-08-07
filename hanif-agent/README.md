# hanif-agent

Personal agent workflows backed by OpenCode.

```sh
hanif-agent review
hanif-agent review --base main
hanif-agent review --repo ~/Projects/example --json
```

The review command compares the merge base with the current effective worktree,
runs independent Luna reviewers, and asks Sol to adjudicate and perform a final
gap review. A paste-ready Markdown report is copied to the macOS clipboard after
every successful run. Completed results are retained as append-only JSONL under
`/tmp/agentic-review` and reused by later runs on the same repository branch.
