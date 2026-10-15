import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { babysitPrompt, parseBabysitCommand, parseBabysitState, type BabysitState } from "./babysit-state.ts";

const STATE_ENTRY = "babysit-state";
const CONTEXT_MESSAGE = "babysit-context";

/** Babysit an interactive Pi session at timed checkpoints; never run a parallel agent. */
export default function babysitExtension(pi: ExtensionAPI): void {
  let state: BabysitState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextCheckAt: number | undefined;
  let resumeOnNextRun = false;
  let sessionReady = false;

  function clearBabysitTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    nextCheckAt = undefined;
  }

  function showBabysitStatus(ctx: ExtensionContext) {
    const next = nextCheckAt === undefined ? "" : ` · next ${new Date(nextCheckAt).toLocaleTimeString()}`;
    ctx.ui.setStatus("babysit", state ? `Babysit: ${state.status}${next}` : undefined);
  }

  function saveBabysitState(ctx: ExtensionContext, next: BabysitState | null) {
    clearBabysitTimer();
    state = next;
    pi.appendEntry(STATE_ENTRY, next);
    const activeTools = new Set(pi.getActiveTools());
    if (next && next.status !== "paused" && next.status !== "complete" && next.status !== "blocked") activeTools.add("babysit_report");
    else activeTools.delete("babysit_report");
    pi.setActiveTools([...activeTools]);
    showBabysitStatus(ctx);
  }

  function sendBabysitPrompt(ctx: ExtensionContext, phase: "clarify" | "check") {
    if (!state) return;
    pi.sendMessage({ customType: CONTEXT_MESSAGE, content: babysitPrompt(state, phase), display: true }, {
      triggerTurn: true,
      deliverAs: "steer",
    });
  }

  function scheduleBabysitCheck(ctx: ExtensionContext) {
    clearBabysitTimer();
    if (!state || state.status !== "active" || !sessionReady) return;
    nextCheckAt = Date.now() + state.intervalMs;
    timer = setTimeout(() => {
      timer = undefined;
      if (!state || state.status !== "active" || !sessionReady) return;
      saveBabysitState(ctx, { ...state, status: "checking" });
      sendBabysitPrompt(ctx, "check");
    }, state.intervalMs);
    timer.unref();
    showBabysitStatus(ctx);
  }

  function beginBabysitClarifications(ctx: ExtensionContext) {
    if (!state) return;
    saveBabysitState(ctx, { ...state, status: "clarifying" });
    sendBabysitPrompt(ctx, "clarify");
  }

  pi.registerTool({
    name: "babysit_report",
    label: "Babysit report",
    description: "Report an active babysit goal: ready after upfront clarifications, continue after a timed progress update, blocked with questions requiring user input, or complete with verification evidence. Never claim completion without evidence.",
    parameters: Type.Object({
      goalId: Type.String({ minLength: 1, description: "Exact goalId from the latest babysit context; rejects stale reports after replacement." }),
      outcome: Type.Union([Type.Literal("ready"), Type.Literal("continue"), Type.Literal("blocked"), Type.Literal("complete")]),
      summary: Type.String({ minLength: 1, description: "Visible update: criteria/plan, progress/evidence/next action, unanswered questions, or completion evidence." }),
    }),
    async execute(_id, input, _signal, _update, ctx) {
      if (!state || state.status === "paused" || state.status === "complete" || state.status === "blocked") {
        return { content: [{ type: "text", text: "Babysit report rejected: no running babysit goal." }], details: undefined, isError: true };
      }
      if (input.goalId !== state.goalId) {
        return { content: [{ type: "text", text: "Babysit report rejected: this report belongs to a replaced goal." }], details: undefined, isError: true };
      }
      if (!input.summary.trim()) {
        return { content: [{ type: "text", text: "Babysit report rejected: supply a nonempty update or evidence." }], details: undefined, isError: true };
      }
      if ((input.outcome === "ready" && state.status !== "clarifying") || (input.outcome === "continue" && state.status !== "checking")) {
        return { content: [{ type: "text", text: "Babysit report rejected: ready is for clarifications; continue is for a periodic check-in." }], details: undefined, isError: true };
      }
      const status = input.outcome === "blocked" ? "blocked" : input.outcome === "complete" ? "complete" : "active";
      saveBabysitState(ctx, { ...state, status, summary: input.summary.trim() });
      pi.sendMessage({ customType: "babysit-update", content: `Babysit ${status}:\n${input.summary.trim()}`, display: true }, { triggerTurn: false });
      if (status === "active") scheduleBabysitCheck(ctx);
      if (status === "blocked") ctx.ui.notify("Babysit paused: answer the questions to resume clarification.", "warning");
      const instruction = status === "active" ? "Continue pursuing the goal unattended." : "Stop work on this goal and leave the session idle after your final update.";

      return { content: [{ type: "text", text: instruction }], details: { status } };
    },
  });
  pi.registerCommand("babysit", {
    description: "Babysit a goal: /babysit 30m <goal> | status | check | pause | resume | stop",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Babysit requires an interactive Pi session that remains running.", "warning");
        return;
      }
      const command = args.trim();
      if (!command || command === "status") {
        ctx.ui.notify(state ? `Babysit ${state.status}\nGoal: ${state.objective}\nInterval: ${state.intervalMs / 60_000}m\nLast update: ${state.summary}` : "Usage: /babysit 30m <goal>", "info");
        return;
      }
      if (command === "stop") {
        resumeOnNextRun = false;
        saveBabysitState(ctx, null);
        pi.sendMessage({ customType: CONTEXT_MESSAGE, content: "Babysitting stopped by the user. Stop autonomous pursuit of the babysit goal; wait for further instructions.", display: true }, { deliverAs: ctx.isIdle() ? "nextTurn" : "steer" });
        return;
      }
      if (command === "pause" || command === "resume" || command === "check") {
        if (!state) { ctx.ui.notify("Babysit: no goal is set.", "warning"); return; }
        if (command === "pause") {
          resumeOnNextRun = false;
          saveBabysitState(ctx, { ...state, status: "paused" });
          pi.sendMessage({ customType: CONTEXT_MESSAGE, content: "Babysitting manually paused. Stop autonomous pursuit of the goal and wait for further instructions.", display: true }, { deliverAs: ctx.isIdle() ? "nextTurn" : "steer" });
        } else if (command === "resume") beginBabysitClarifications(ctx);
        else if (state.status === "active") {
          saveBabysitState(ctx, { ...state, status: "checking" });
          sendBabysitPrompt(ctx, "check");
        } else ctx.ui.notify("Babysit: resume and resolve clarifications before requesting a check-in.", "warning");
        return;
      }
      const parsed = parseBabysitCommand(command);
      if (!parsed) { ctx.ui.notify("Babysit: use /babysit 30m <goal>; intervals must be 1s–7d (s, m, h).", "warning"); return; }
      if (state && !(await ctx.ui.confirm("Replace babysit goal?", state.objective))) return;
      resumeOnNextRun = false;
      saveBabysitState(ctx, { ...parsed, goalId: randomUUID(), status: "clarifying", summary: "Clarifications pending" });
      sendBabysitPrompt(ctx, "clarify");
    },
  });

  function restoreBabysitSession(ctx: ExtensionContext) {
    clearBabysitTimer();
    resumeOnNextRun = false;
    sessionReady = ctx.mode === "tui";
    state = null;
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      state = parseBabysitState(entry.data);
      break;
    }
    // Never silently restart unattended work after reload, resume, or branch navigation.
    if (state && state.status !== "blocked" && state.status !== "complete" && state.status !== "paused") {
      saveBabysitState(ctx, { ...state, status: "paused" });
      ctx.ui.notify("Babysit restored paused. Use /babysit resume to clarify and continue.", "info");
    } else {
      const activeTools = pi.getActiveTools().filter(name => name !== "babysit_report");
      pi.setActiveTools(activeTools);
      showBabysitStatus(ctx);
    }
  }

  pi.on("session_start", (_event, ctx) => restoreBabysitSession(ctx));
  pi.on("session_tree", (_event, ctx) => restoreBabysitSession(ctx));
  pi.on("session_shutdown", () => { sessionReady = false; clearBabysitTimer(); });
  pi.on("input", (event, ctx) => {
    if (sessionReady && event.source !== "extension" && event.text.trim() && state?.status === "blocked") {
      if (event.streamingBehavior) beginBabysitClarifications(ctx);
      else resumeOnNextRun = true;
    }
    return { action: "continue" };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!resumeOnNextRun || !state || state.status !== "blocked") return;
    resumeOnNextRun = false;
    saveBabysitState(ctx, { ...state, status: "clarifying" });
    return { message: { customType: CONTEXT_MESSAGE, content: babysitPrompt(state, "clarify"), display: true } };
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome === "error" && state && state.status !== "complete" && state.status !== "blocked" && state.status !== "paused") {
      saveBabysitState(ctx, { ...state, status: "paused", summary: "Agent failed; use /babysit resume after resolving the error." });
    }
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!state || state.status === "complete" || state.status === "paused" || state.status === "blocked") return;
    if (event.aborted) {
      saveBabysitState(ctx, { ...state, status: "paused", summary: "Agent interrupted; use /babysit resume." });
    } else if (state.status === "clarifying" || state.status === "checking") {
      saveBabysitState(ctx, { ...state, status: "blocked", summary: "Agent stopped without a babysit report. Reply to clarify or use /babysit resume." });
      ctx.ui.notify("Babysit paused: agent stopped without reporting its goal status.", "warning");
    }
  });
}
