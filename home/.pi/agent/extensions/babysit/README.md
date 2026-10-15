# Babysit

Timed goal check-ins for interactive Pi. This is not a continuation after every response and does not spawn another agent.

```text
/babysit 30m Achieve sandbox startup under 100ms
/babysit status
/babysit check
/babysit pause
/babysit resume
/babysit stop
```

## Behavior

1. Starting or resuming requests upfront clarification of success criteria, measurements, scope, constraints, and decisions. Already-answered questions should not be repeated.
2. The agent asks any necessary questions and reports `blocked`, or reports `ready` and starts unattended work.
3. Every interval, request a visible update with measurements/evidence and an answer to whether the goal is achieved. A busy agent receives steering input; an idle agent is woken in the same session.
4. A `continue` report schedules the next interval and instructs the agent to pursue the next concrete action. There is no immediate automatic restart after an ordinary response; if the agent settles early, the next timed check wakes it.
5. A `complete` report requires evidence, cancels the timer, and asks the agent to finish its update and remain idle.
6. A `blocked` report cancels the timer. The next nonempty user prompt triggers another clarification pass. This does not assume the answer resolves every question. A manual pause does **not** automatically resume on user input.

Intervals use `s`, `m`, or `h`, from one second to seven days. A new interval starts after the agent's `ready` or `continue` report; there is only one outstanding check-in, not an accumulating queue. `check` requests an early check-in when active.

## Context and safety

Unattended-work and check-in instructions are appended as custom conversation messages, never prepended to or substituted for the system prompt. This avoids rewriting the existing conversation prefix; actual provider caching still depends on Pi and the provider, including tool declaration changes and compaction.

`babysit_report` is the explicit reporting protocol, with outcomes `ready`, `continue`, `blocked`, and `complete`. Reports include the current goal ID so replies to a replaced goal cannot complete the new one. Report summaries are displayed in the transcript. Completion remains the agent's evidence-backed judgment, not an independent benchmark verifier.

If a clarification/check-in ends without a report, babysitting pauses as blocked rather than silently proceeding. An interruption or final agent error pauses it. Reloading, session restoration, or tree navigation restores running goals as manually paused; use `resume` to restart with clarification. Shutdown clears timers. Pi must remain running in interactive mode.

The extension relies on the agent to call `babysit_report` when it needs input; it does not guess questions from prose or intercept arbitrary other extensions' dialogs. Pausing/stopping cancels babysitting and tells the agent to stop autonomous goal work, but does not forcibly terminate an already executing command or undo external effects. Existing permissions still apply. State is kept in the active Pi session branch, not in the dotfiles repository.

## Files and verification

- `babysit-extension.ts`: Pi lifecycle, command, reporting tool, timer ownership.
- `babysit-state.ts`: command/state parsing and append-only prompts.
- `babysit.test.ts`: real Pi extension loader/runner integration tests with virtual time; no model/API calls.
- `index.ts`: Pi-discoverable entrypoint.

Develop against `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.2.0 or compatible APIs. With those packages available to Node and TypeScript installed, run `npm test` and `npm run typecheck`. TypeScript compilation uses strict settings. Tests cover timed continuation, clarification/resumption, completion, stale reports, invalid intervals/state, reload, interruption, errors, and shutdown cleanup.
