---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
metadata:
  opencode/autoinvoke: false
---

Interview the user relentlessly until you reach a shared understanding. Map the discussion as a **design tree**: every decision branches into the decisions that depend on it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are settled: the questions you can ask now without guessing at answers you have not heard yet. Ask all and only independent frontier questions in one round, number each question, and give your recommended answer. Never bundle questions when one depends on another; defer dependent questions to a later round. Then wait for the user's answers.

Format each question as:

```markdown
**Q1 - <question title>:** <question body and choices>

**Recommended:** <your recommended answer>
```

Each answer reshapes the tree. Recompute the frontier after every round and ask the newly unblocked questions. A question with an unsettled prerequisite belongs to a later round.

Finding facts is your job, never the user's. When a frontier question needs a fact from the environment, dispatch a subagent to find it rather than asking the user. Continue with unaffected frontier questions while it runs; only downstream questions wait. Decisions remain the user's: put each one to them and wait.

The session is done when the frontier is empty: every branch has been visited and nothing remains silently assumed. Do not act until the user confirms you have reached a shared understanding.
