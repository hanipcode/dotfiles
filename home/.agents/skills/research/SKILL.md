---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up **exactly one background agent** to do the research, so you keep working while it reads.

## Recursion guard

Before spawning, check `RESEARCH_SUBAGENT`:

- If `RESEARCH_SUBAGENT=1`, this is already the delegated researcher. Perform the research and write the report directly without spawning another agent or pane.
- If `HERDR_ENV=1`, create one background pane with `herdr pane split ... --env RESEARCH_SUBAGENT=1` and explicitly tell that agent not to delegate or spawn subagents.
- Otherwise, use the platform's single background-agent mechanism and put the same no-delegation instruction in its prompt.

Never create a second research agent as a retry. If the delegated agent stalls or fails, stop or close it and complete the research in the original session.

The background agent's job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
