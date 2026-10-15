import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { parseBabysitCommand, parseBabysitState } from "./babysit-state.ts";

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

async function createBabysitHarness() {
  const sessionManager = SessionManager.inMemory("/tmp");
  const loaded = await discoverAndLoadExtensions([extensionPath], "/tmp", "/tmp/babysit-agent");
  assert.deepEqual(loaded.errors, []);
  let activeTools: string[] = ["read", "bash"];
  const messages: Array<{ content: string; triggerTurn: boolean; deliverAs: string | undefined }> = [];
  loaded.runtime.sendMessage = (message, options) => {
    assert.equal(typeof message.content, "string");
    messages.push({ content: String(message.content), triggerTurn: options?.triggerTurn ?? false, deliverAs: options?.deliverAs });
  };
  loaded.runtime.appendEntry = (name, data) => { sessionManager.appendCustomEntry(name, data); };
  loaded.runtime.getActiveTools = () => activeTools;
  loaded.runtime.setActiveTools = names => { activeTools = names; };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, "/tmp", sessionManager, new ModelRegistry(modelRuntime));
  const errors: string[] = [];
  runner.onError(error => errors.push(error.error));
  runner.setUIContext({ ...runner.getUIContext(), notify() {}, setStatus() {}, confirm: async () => true }, "tui");
  await runner.emit({ type: "session_start", reason: "startup" });
  const command = runner.getCommand("babysit");
  const report = runner.getToolDefinition("babysit_report");
  assert.ok(command);
  assert.ok(report);

  return {
    messages, errors, runner,
    state() {
      const entry = [...sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "babysit-state");
      return entry?.type === "custom" ? parseBabysitState(entry.data) : null;
    },
    command: (args: string) => command.handler(args, runner.createCommandContext()),
    report: (outcome: "ready" | "continue" | "blocked" | "complete", summary = "Evidence and next step", goalId?: string) => report.execute("report", { outcome, summary, goalId: goalId ?? (() => {
      const entry = [...sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "babysit-state");
      return entry?.type === "custom" ? parseBabysitState(entry.data)?.goalId ?? "" : "";
    })() }, undefined, undefined, runner.createToolContext("report", undefined)),
    shutdown: () => runner.emit({ type: "session_shutdown", reason: "quit" }),
  };
}

test("babysit interval parsing rejects invalid and unsafe timers", () => {
  assert.equal(parseBabysitCommand("30m Sandbox under 100ms")?.intervalMs, 1_800_000);
  for (const input of ["0m goal", "999999999h goal", "30m", "garbage", "0.0001s goal"]) assert.equal(parseBabysitCommand(input), null);
  for (let seconds = 1; seconds <= 500; seconds += 7) {
    const state = parseBabysitCommand(`${seconds}s Goal`);
    assert.ok(state);
    const storedState = { ...state, goalId: "roundtrip-goal", status: "clarifying", summary: "" };
    assert.deepEqual(parseBabysitState(JSON.parse(JSON.stringify(storedState))), storedState);
  }
  assert.equal(parseBabysitState({ objective: "Goal", intervalMs: 1, status: "active", summary: "" }), null);
});

test("startup clarifies first and appends unattended context without rewriting the system prompt", async () => {
  const harness = await createBabysitHarness();
  try {
    await harness.command("30m Sandbox under 100ms");
    assert.equal(harness.state()?.status, "clarifying");
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0]?.content ?? "", /user will be unattended/);
    assert.match(harness.messages[0]?.content ?? "", /Ask all necessary clarifications upfront/);
    assert.equal(harness.messages[0]?.triggerTurn, true);
    const result = await harness.report("continue");
    assert.equal(result.isError, true);
    assert.deepEqual(harness.errors, []);
  } finally { await harness.shutdown(); }
});

test("timed check-ins repeat only after reports and completion stops timers", async context => {
  const harness = await createBabysitHarness();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    await harness.command("30m Sandbox under 100ms");
    await harness.report("ready");
    assert.equal(harness.state()?.status, "active");
    const count = harness.messages.length;
    context.mock.timers.tick(1_799_999);
    assert.equal(harness.messages.length, count);
    context.mock.timers.tick(1);
    assert.equal(harness.state()?.status, "checking");
    assert.match(harness.messages.at(-1)?.content ?? "", /Periodic check-in/);
    await harness.report("continue", "p95 120ms; optimize initialization next");
    context.mock.timers.tick(1_800_000);
    assert.equal(harness.state()?.status, "checking");
    await harness.report("complete", "p95 90ms across 100 measured runs");
    const completedCount = harness.messages.length;
    context.mock.timers.tick(10_000_000);
    assert.equal(harness.messages.length, completedCount);
    assert.equal(harness.state()?.status, "complete");
    assert.deepEqual(harness.errors, []);
  } finally { await harness.shutdown(); }
});

test("blocked goals pause and user answers trigger clarification before resuming", async context => {
  const harness = await createBabysitHarness();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    await harness.command("30m Sandbox under 100ms");
    await harness.report("blocked", "Measure cold-start p95 or median?");
    const count = harness.messages.length;
    context.mock.timers.tick(10_000_000);
    assert.equal(harness.messages.length, count);
    await harness.runner.emitInput("Use cold-start p95 across 100 runs", undefined, "interactive");
    const result = await harness.runner.emitBeforeAgentStart({ messageType: "user", prompt: "Use cold-start p95 across 100 runs" }, { cwd: "/tmp" });
    assert.equal(harness.state()?.status, "clarifying");
    assert.equal(result.messages.length, 1);
    assert.match(String(result.messages[0]?.content), /any user answer/);
    await harness.report("ready");
    context.mock.timers.tick(1_800_000);
    assert.equal(harness.state()?.status, "checking");
  } finally { await harness.shutdown(); }
});

test("manual pause does not auto-resume; explicit resume clarifies again", async () => {
  const harness = await createBabysitHarness();
  try {
    await harness.command("30m Goal");
    await harness.report("ready");
    await harness.command("pause");
    await harness.runner.emitInput("Hello", undefined, "interactive");
    await harness.runner.emitBeforeAgentStart({ messageType: "user", prompt: "Hello" }, { cwd: "/tmp" });
    assert.equal(harness.state()?.status, "paused");
    await harness.command("resume");
    assert.equal(harness.state()?.status, "clarifying");
    assert.match(harness.messages.at(-1)?.content ?? "", /Before starting or resuming/);
  } finally { await harness.shutdown(); }
});

test("reload restores paused, missing reports block, interruption pauses, stop clears", async () => {
  const harness = await createBabysitHarness();
  try {
    await harness.command("30m Goal");
    await harness.runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(harness.state()?.status, "blocked");
    await harness.command("resume");
    await harness.report("ready");
    await harness.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(harness.state()?.status, "paused");
    await harness.command("resume");
    await harness.report("ready");
    await harness.runner.emit({ type: "agent_settled", aborted: true });
    assert.equal(harness.state()?.status, "paused");
    await harness.command("stop");
    assert.equal(harness.state(), null);
    assert.deepEqual(harness.errors, []);
  } finally { await harness.shutdown(); }
});

test("shutdown cancels timers; replaced goals reject stale completion reports", async context => {
  const harness = await createBabysitHarness();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    await harness.command("1s First goal");
    const firstGoalId = harness.state()?.goalId;
    assert.ok(firstGoalId);
    await harness.report("ready");
    await harness.command("1s Replacement goal");
    const stale = await harness.report("complete", "Old evidence", firstGoalId);
    assert.equal(stale.isError, true);
    assert.equal(harness.state()?.status, "clarifying");
    await harness.report("ready");
    await harness.shutdown();
    const count = harness.messages.length;
    context.mock.timers.tick(10_000);
    assert.equal(harness.messages.length, count);
  } finally { await harness.shutdown(); }
});

test("a streaming user answer also resumes blocked goals through clarification", async () => {
  const harness = await createBabysitHarness();
  try {
    await harness.command("30m Goal");
    await harness.report("blocked", "Which target?");
    await harness.runner.emitInput("Target A", undefined, "interactive", "steer");
    assert.equal(harness.state()?.status, "clarifying");
    assert.match(harness.messages.at(-1)?.content ?? "", /Ask all necessary clarifications upfront/);
    const missingEvidence = await harness.report("complete", "   ");
    assert.equal(missingEvidence.isError, true);
    assert.equal(harness.state()?.status, "clarifying");
  } finally { await harness.shutdown(); }
});

test("agent errors pause active goals rather than reawakening them", async () => {
  const harness = await createBabysitHarness();
  try {
    await harness.command("30m Goal");
    await harness.report("ready");
    await harness.runner.emitBoundary({ type: "agent_before_settle", outcome: "error" }, () => ({
      contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false,
    }));
    assert.equal(harness.state()?.status, "paused");
    assert.deepEqual(harness.errors, []);
  } finally { await harness.shutdown(); }
});
