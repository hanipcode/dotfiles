# Logic Prototype

A small interactive demo that lets someone drive a state model by hand. Use this when the question is about **business logic, state transitions, or data shape** — the kind of thing that looks reasonable on paper but only feels wrong once you push it through real cases.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where someone wants to **press buttons and watch state change**.

If the question is "what should this look like" — wrong branch. Use [UI.md](UI.md).

## Pick the delivery shape

Default to a **single, self-contained HTML file**. It is a shareable demo with nothing to install, so a designer, PM, or domain expert can feel the model directly in domain language rather than code vocabulary.

Use the **host-language TUI fallback** only when the question specifically depends on host-runtime behavior, portability into a non-JavaScript module, terminal interaction, or the user explicitly requests a TUI.

## Shareable HTML process

### 1. State the question visibly

Write the state model and exact question in a visible introduction at the top of the demo, not only in a comment. The recipient must be able to check that the demo answers the intended question without reading source.

### 2. Isolate portable logic

Put the logic in a single `<script>` block as a small, pure module that can be lifted into production code later. Choose the shape that fits the question: a pure reducer, explicit state machine, pure function set, or a class/module with a clear method surface.

Keep the model independent of the shell: no DOM access, `document`, or button handlers inside it. The page calls the model; nothing flows the other direction.

### 3. Build one shareable file

Use plain inline HTML, CSS, and JavaScript with no framework, bundler, or server. It must open by double-click and survive being emailed around.

Use domain-language labels and explain behavior in plain words. Lay out:

1. **Title and one-line explanation** of the question being explored.
2. **Current state** as readable labelled fields, re-rendered after every action, with a short callout for the last change when useful.
3. **Free-play controls** with one always-available button per action.
4. **Guided walkthroughs** as scenario tabs with a plain-language setup, what to watch for, and ordered real action buttons. Starting a walkthrough resets to a known state.

Include scenarios for the happy path, a tricky edge case, and an illegal attempt. Keep the presentation restrained: clean typography, generous spacing, one accent color, and no animation or gimmicks competing with the model.

### 4. Hand it over and capture it

Open or send the file so the recipient can use guided scenarios and free play. Once it answers the question, lift the validated model into the real module and capture the HTML shell on the throwaway branch described by [SKILL.md](SKILL.md).

Do not add tests, wire it to the real database, generalize beyond the question, couple the model to DOM concerns, require build tooling, or ship the HTML shell to production.

## Host-language TUI fallback

Use this process only when the delivery-shape criteria above select the fallback.

### 1. State the question

Before writing code, write down what state model and what question you're prototyping. One paragraph, in the prototype's README or a comment at the top of the file. A logic prototype that answers the wrong question is pure waste — make the question explicit so it can be checked later, whether the user is watching now or returning to it AFK.

### 2. Pick the language

Use whatever the host project uses. If the project has no obvious runtime (e.g. a docs repo), ask.

Match the project's existing conventions for tooling — don't add a new package manager or runtime just for the prototype.

### 3. Isolate the logic in a portable module

Put the actual logic — the bit that's answering the question — behind a small, pure interface that could be lifted out and dropped into the real codebase later. The TUI around it is throwaway; the logic module shouldn't be.

The right shape depends on the question:

- **A pure reducer** — `(state, action) => state`. Good when actions are discrete events and state is a single value.
- **A state machine** — explicit states and transitions. Good when "which actions are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no implicit current state — just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.

Pick whichever shape best fits the question being asked, *not* whichever is easiest to wire to a TUI. Keep it pure: no I/O, no terminal code, no `console.log` for control flow. The TUI imports it and calls into it; nothing flows the other direction.

This is what makes the prototype useful past its own lifetime: when the question's been answered, the validated reducer / machine / function set can be lifted into the real module on its own.

### 4. Build the smallest TUI that exposes the state

Build it as a **lightweight TUI** — on every tick, clear the screen (`console.clear()` / `print("\033[2J\033[H")` / equivalent) and re-render the whole frame. The user should always see one stable view, not an ever-growing scrollback.

Each frame has two parts, in this order:

1. **Current state**, pretty-printed and diff-friendly (one field per line, or formatted JSON). Use **bold** for field names or section headers and **dim** for less important context (timestamps, IDs, derived values). Native ANSI escape codes are fine — `\x1b[1m` bold, `\x1b[2m` dim, `\x1b[0m` reset. No need to pull in a styling library unless one is already in the project.
2. **Keyboard shortcuts**, listed at the bottom: `[a] add user  [d] delete user  [t] tick clock  [q] quit`. Bold the key, dim the description, or vice-versa — whatever reads cleanly.

Behaviour:

1. **Initialise state** — a single in-memory object/struct. Render the first frame on start.
2. **Read one keystroke (or one line)** at a time, dispatch to a handler that mutates state.
3. **Re-render** the full frame after every action — don't append, replace.
4. **Loop until quit.**

The whole frame should fit on one screen.

### 5. Make it runnable in one command

Add a script to the project's existing task runner (`package.json` scripts, `Makefile`, `justfile`, `pyproject.toml`). The user should run `pnpm run <prototype-name>` or equivalent — never need to remember a path.

If the host project has no task runner, just put the command at the top of the prototype's README.

### 6. Hand it over

Give the user the run command. They'll drive it themselves; the interesting moments are when they say "wait, that shouldn't be possible" or "huh, I assumed X would be different" — those are the bugs in the _idea_, which is the whole point. If they want new actions added, add them. Prototypes evolve.

### 7. Capture the answer and the prototype

Once the prototype has answered its question, capture the answer, then capture the prototype the way the [SKILL](SKILL.md) describes. The logic-specific mapping: the validated reducer / machine / function set lifts into the real module (the decision, absorbed); the TUI shell rides along to the throwaway branch that keeps the prototype as a primary source.

## Anti-patterns

- **Don't add tests.** A prototype that needs tests is no longer a prototype.
- **Don't wire it to the real database.** Use an in-memory store unless the question is specifically about persistence.
- **Don't generalise.** No "what if we wanted to support X later." The prototype answers one question.
- **Don't blur the logic and the TUI together.** If the reducer / state machine references `console.log`, prompts, or terminal escape codes, it's no longer portable. Keep the TUI as a thin shell over a pure module.
- **Don't ship the TUI shell into production.** The shell is optimised for being driven by hand from a terminal. The logic module behind it is the bit worth keeping.
