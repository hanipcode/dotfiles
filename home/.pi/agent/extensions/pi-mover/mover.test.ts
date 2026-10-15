import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { SessionManager, SettingsManager, ModelRuntime, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { filterMoverWorktrees, formatMoverRecency, parseMoverWorktrees, sortMoverWorktrees, type MoverWorktree } from "./mover-domain.ts";
import { MoverPicker, type MoverPickerAction } from "./mover-picker.ts";
import { MoverWorktrees, type MoverCommands } from "./mover-worktrees.ts";
import { archiveMoverSource, prepareMoverSession } from "./mover-sessions.ts";
import { MoverHerdr } from "./mover-herdr.ts";

const exec = promisify(execFile);
const commands: MoverCommands = {
  async run(command, args, cwd) {
    try {
      const result = await exec(command, args, { cwd, encoding: "utf8" });
      return { code: 0, ...result };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" && "stdout" in error && typeof error.stdout === "string" && "stderr" in error && typeof error.stderr === "string") return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      throw error;
    }
  },
};

async function git(cwd: string, args: string[]) {
  const result = await commands.run("git", args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-test-"));
  const source = join(directory, "seed");
  const remote = join(directory, "origin.git");
  const root = join(directory, "project");
  await mkdir(source);
  await git(source, ["init", "-q", "-b", "main"]);
  await git(source, ["config", "user.name", "Mover Test"]);
  await git(source, ["config", "user.email", "mover@example.test"]);
  await writeFile(join(source, "README.md"), "initial\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-qm", "initial"]);
  await git(directory, ["clone", "-q", "--bare", source, remote]);
  await git(directory, ["clone", "-q", remote, root]);
  const worktrees = new MoverWorktrees(commands, join(directory, "visits"));
  return { directory, source, remote, root, worktrees };
}

function requireMoverValue<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!result.ok) assert.fail(result.error.message);
  return result.value;
}

test("worktree parser, filtering, recency, and ordering preserve absent locks", () => {
  const trees = requireMoverValue(parseMoverWorktrees("worktree /repo/main\0HEAD abc\0branch refs/heads/main\0\0worktree /repo/topic\0HEAD abc\0detached\0locked\0\0"));
  assert.equal(trees[0]?.locked, false);
  assert.equal(trees[0]?.branch, "main");
  assert.equal(trees[1]?.locked, true);
  assert.equal(trees[1]?.branch, null);
  assert.equal(filterMoverWorktrees(trees, "TOPIC").length, 1);
  assert.equal(formatMoverRecency(null, 1_000), "not visited");
  assert.equal(formatMoverRecency(0, 3_600_000), "1h ago");
  assert.equal(sortMoverWorktrees([{ ...trees[0], path: "/older", branch: "main", locked: false, bare: false, lastVisited: 10 }, { path: "/newer", branch: null, locked: false, bare: false, lastVisited: 20 }])[0]?.path, "/newer");
  assert.equal(parseMoverWorktrees("HEAD abc\0\0").ok, false);
});

test("creation fetches origin/main and never bases from current feature branch", async context => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.root, ["config", "user.name", "Mover Test"]);
  await git(fixture.root, ["config", "user.email", "mover@example.test"]);
  await git(fixture.root, ["switch", "-qc", "unrelated-feature"]);
  await writeFile(join(fixture.root, "feature.txt"), "not the base\n");
  await git(fixture.root, ["add", "."]);
  await git(fixture.root, ["commit", "-qm", "feature"]);
  const featureHead = await git(fixture.root, ["rev-parse", "HEAD"]);
  // Main must refresh even when a bare/custom clone lacks the standard origin fetch mapping.
  await git(fixture.root, ["config", "--unset-all", "remote.origin.fetch"]);
  await writeFile(join(fixture.source, "upstream.txt"), "latest main\n");
  await git(fixture.source, ["add", "."]);
  await git(fixture.source, ["commit", "-qm", "new main"]);
  await git(fixture.source, ["push", fixture.remote, "main"]);
  const remoteHead = await git(fixture.source, ["rev-parse", "HEAD"]);
  const target = requireMoverValue(await fixture.worktrees.create(fixture.root, "sandbox/perf"));
  assert.equal(await git(target, ["rev-parse", "HEAD"]), remoteHead);
  assert.notEqual(remoteHead, featureHead);
  assert.equal(await git(target, ["status", "--porcelain"]), "");
  assert.equal(await git(target, ["branch", "--show-current"]), "sandbox/perf");
  assert.equal((await fixture.worktrees.create(fixture.root, "sandbox/perf")).ok, false);
});

test("creation falls back to local main when origin has no main, and fails when neither exists", async context => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const emptyRemote = join(fixture.directory, "empty.git");
  await git(fixture.directory, ["init", "-q", "--bare", emptyRemote]);
  await git(fixture.root, ["remote", "set-url", "origin", emptyRemote]);
  const localMain = await git(fixture.root, ["rev-parse", "main"]);
  const target = requireMoverValue(await fixture.worktrees.create(fixture.root, "local-base"));
  assert.equal(await git(target, ["rev-parse", "HEAD"]), localMain);
  await git(fixture.root, ["remote", "remove", "origin"]);
  await git(fixture.root, ["branch", "-m", "main", "trunk"]);
  assert.equal((await fixture.worktrees.create(fixture.root, "no-base")).ok, false);
});

test("fetch failures are surfaced rather than silently falling back", async context => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await git(fixture.root, ["remote", "set-url", "origin", join(fixture.directory, "missing-origin")]);
  assert.equal((await fixture.worktrees.create(fixture.root, "bad-fetch")).ok, false);
  assert.equal(await git(fixture.root, ["branch", "--list", "bad-fetch"]), "");
});

test("deletion refuses current, dirty, and locked worktrees and keeps clean branches", async context => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  assert.equal((await fixture.worktrees.remove(fixture.root, fixture.root)).ok, false);
  const target = requireMoverValue(await fixture.worktrees.create(fixture.root, "delete-me"));
  await writeFile(join(target, "dirty.txt"), "keep me\n");
  assert.equal((await fixture.worktrees.remove(fixture.root, target)).ok, false);
  await rm(join(target, "dirty.txt"));
  await git(fixture.root, ["worktree", "lock", target]);
  assert.equal((await fixture.worktrees.remove(fixture.root, target)).ok, false);
  await git(fixture.root, ["worktree", "unlock", target]);
  requireMoverValue(await fixture.worktrees.remove(fixture.root, target));
  assert.match(await git(fixture.root, ["branch", "--list", "delete-me"]), /delete-me/);
});

test("recency uses visits, shared safely between panes, not filesystem modifications", async context => {
  const fixture = await createRepository();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const target = requireMoverValue(await fixture.worktrees.create(fixture.root, "recent"));
  context.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  requireMoverValue(await fixture.worktrees.visit(fixture.root));
  context.mock.timers.tick(60_000);
  await Promise.all([fixture.worktrees.visit(target), fixture.worktrees.visit(target)]);
  const inventory = requireMoverValue(await fixture.worktrees.list(fixture.root));
  assert.equal(inventory.worktrees[0]?.path, target);
  assert.equal(inventory.worktrees[0]?.lastVisited, 61_000);
});

test("move preserves session ID, complete history, selected branch, and source until success", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-session-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = SessionManager.create(directory, join(directory, "original"));
  original.appendMessage({ role: "user", content: "Selected branch", timestamp: 1 });
  const selected = original.getLeafId();
  original.appendMessage({ role: "user", content: "Abandoned branch", timestamp: 2 });
  const source = original.getSessionFile();
  assert.ok(source);
  // Persist a real file even when a session has not yet emitted an assistant response.
  await writeFile(source, [original.getHeader(), ...original.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const sourceContents = await readFile(source, "utf8");
  const targetCwd = join(directory, "target-worktree");
  await mkdir(targetCwd);
  const prepared = requireMoverValue(await prepareMoverSession({ source, targetCwd, leafId: selected, sessionDirectory: join(directory, "moved") }));
  const moved = SessionManager.open(prepared.path);
  assert.equal(moved.getSessionId(), original.getSessionId());
  assert.equal(moved.getCwd(), targetCwd);
  assert.equal(moved.getEntries().filter(entry => entry.type === "message").length, 2);
  assert.equal(moved.getBranch().filter(entry => entry.type === "message").length, 1);
  assert.equal(await readFile(source, "utf8"), sourceContents);
  const backup = requireMoverValue(await archiveMoverSource(source, join(directory, "backups")));
  assert.equal(await readFile(backup, "utf8"), sourceContents);
  await assert.rejects(readFile(source));
});

test("picker supports typed d, list deletion, empty-match creation, Shift+Enter, and bounded rendering", () => {
  const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
  const trees: MoverWorktree[] = [{ path: "/repo/main", branch: "main", locked: false, bare: false, lastVisited: 1 }];
  const actions: MoverPickerAction[] = [];
  const picker = new MoverPicker(trees, "/repo/main", theme, action => actions.push(action), () => {});
  picker.focused = true;
  picker.handleInput("d");
  assert.equal(actions.length, 0);
  picker.handleInput("\r");
  assert.deepEqual(actions.pop(), { kind: "create", name: "d", sessionMode: "move" });
  const deletion = new MoverPicker(trees, "/repo/main", theme, action => actions.push(action), () => {});
  deletion.handleInput("\t");
  deletion.handleInput("d");
  assert.deepEqual(actions.pop(), { kind: "delete", path: "/repo/main" });
  const herdrPicker = new MoverPicker(trees, "/repo/main", theme, action => actions.push(action), () => {});
  herdrPicker.handleInput("nonexistent");
  herdrPicker.handleInput("\x1b[13;2u");
  assert.deepEqual(actions.pop(), { kind: "create", name: "nonexistent", sessionMode: "move" });
  for (const width of [20, 40, 80]) for (const line of deletion.render(width)) assert.ok(visibleWidth(line) <= width, `line overflow at ${width}`);
});

test("Herdr opens the relocated session with the same ID and full history in a native worktree", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-herdr-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = SessionManager.create(directory, join(directory, "original"));
  original.appendMessage({ role: "user", content: "Continue this session", timestamp: 1 });
  const source = original.getSessionFile();
  assert.ok(source);
  await writeFile(source, [original.getHeader(), ...original.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const contents = await readFile(source, "utf8");
  const prepared = requireMoverValue(await prepareMoverSession({
    source, targetCwd: "/repo/new", leafId: original.getLeafId(), sessionDirectory: join(directory, "destination"),
  }));
  const recorded: string[][] = [];
  const responses = [
    { result: { workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" }, already_open: false } },
    { result: { agent: { pane_id: "w2:p1" } } },
    { result: {} },
  ];
  const recording: MoverCommands = { async run(command, args) {
    assert.equal(command, "herdr");
    recorded.push(args);
    return { code: 0, stdout: JSON.stringify(responses.shift()), stderr: "" };
  } };
  const herdr = new MoverHerdr(recording, "w1");
  const opened = requireMoverValue(await herdr.openWorktree({ cwd: "/repo/main", path: "/repo/new", label: "new" }));
  assert.equal(opened.kind, "created");
  if (opened.kind !== "created") assert.fail("Expected a new workspace");
  requireMoverValue(await herdr.startSession({ cwd: "/repo/main", ...opened, sessionPath: prepared.path }));
  assert.deepEqual(recorded[0], ["worktree", "open", "--workspace", "w1", "--path", "/repo/new", "--label", "new", "--no-focus"]);
  assert.ok(recorded[1]?.includes("w2:p1"));
  assert.deepEqual(recorded[1]?.slice(-3), ["--", "--session", prepared.path]);
  assert.deepEqual(recorded[2], ["workspace", "focus", "w2"]);
  const resumed = SessionManager.open(prepared.path);
  assert.equal(resumed.getSessionId(), original.getSessionId());
  assert.equal(resumed.getCwd(), "/repo/new");
  assert.equal(resumed.getHeader()?.parentSession, undefined);
  assert.equal(resumed.getBranch().filter(entry => entry.type === "message").length, 1);
  assert.equal(await readFile(source, "utf8"), contents);
});

test("already-open native worktrees never receive a replacement agent", async () => {
  const calls: string[][] = [];
  const recording: MoverCommands = { async run(_command, args) {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: "w2" }, already_open: true } }), stderr: "" };
  } };
  const result = requireMoverValue(await new MoverHerdr(recording, "w1").openWorktree({ cwd: "/repo/main", path: "/repo/new", label: "new" }));
  assert.equal(result.kind, "existing");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.[0], "worktree");
  assert.deepEqual(calls[1], ["workspace", "focus", "w2"]);
  assert.ok(calls.every(args => args[0] !== "agent"));
});

test("deletion is refused when another Herdr pane uses a checkout", async () => {
  const recording: MoverCommands = { async run() { return { code: 0, stdout: JSON.stringify({ result: { panes: [{ cwd: "/repo/main", foreground_cwd: "/repo/topic/src" }] } }), stderr: "" }; } };
  const herdr = new MoverHerdr(recording, "w1");
  assert.equal((await herdr.checkUnused("/repo/main", "/repo/topic")).ok, false);
  assert.equal((await herdr.checkUnused("/repo/main", "/repo/other")).ok, true);
});

test("real Pi runtime replacement rebuilds cwd-bound tools and preserves the conversation", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-runtime-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const originalCwd = join(directory, "original");
  const targetCwd = join(directory, "target");
  await mkdir(originalCwd);
  await mkdir(targetCwd);
  await writeFile(join(originalCwd, "location.txt"), "ORIGINAL");
  await writeFile(join(targetCwd, "location.txt"), "TARGET");
  const manager = SessionManager.create(originalCwd, join(directory, "sessions-original"));
  manager.appendMessage({ role: "user", content: "Preserve this conversation", timestamp: 1 });
  const source = manager.getSessionFile();
  assert.ok(source);
  await writeFile(source, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const moved = requireMoverValue(await prepareMoverSession({ source, targetCwd, leafId: manager.getLeafId(), sessionDirectory: join(directory, "sessions-target") }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: join(directory, "agent"), modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
    });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent ? { sessionStartEvent } : {}) })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd: originalCwd, agentDir: join(directory, "agent"), sessionManager: SessionManager.open(source) });
  try {
    const result = await runtime.switchSession(moved.path);
    assert.equal(result.cancelled, false);
    assert.equal(runtime.session.sessionManager.getCwd(), targetCwd);
    assert.equal(runtime.session.sessionManager.getSessionId(), manager.getSessionId());
    assert.match(runtime.session.systemPrompt, /target/);
    const tools = runtime.session.getAllTools();
    assert.ok(tools.some(tool => tool.name === "read"));
    const reader = runtime.session.agent.state.tools.find(tool => tool.name === "read");
    assert.ok(reader);
    const read = await reader.execute("test-read", { path: "location.txt" });
    assert.deepEqual(read.content, [{ type: "text", text: "TARGET" }]);
    assert.ok(runtime.session.messages.some(message => message.role === "user" && message.content === "Preserve this conversation"));
  } finally { await runtime.dispose(); }
});

test("failed preparation cleans staged files without altering the source", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-failed-stage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.jsonl");
  const header = { type: "session", version: 3, id: "test-session", timestamp: new Date().toISOString(), cwd: directory };
  const contents = JSON.stringify(header) + "\n";
  await writeFile(source, contents);
  const destination = join(directory, "destination");
  const prepared = await prepareMoverSession({ source, targetCwd: directory, leafId: "missing-leaf", sessionDirectory: destination });
  assert.equal(prepared.ok, false);
  assert.equal(await readFile(source, "utf8"), contents);
  await assert.rejects(readFile(join(destination, "source.jsonl")));
});

test("generated path rows preserve branch names and stay bounded with Unicode", () => {
  const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
  for (let index = 0; index < 40; index++) {
    const path = `/very/long/shared/repository/prefix/${"项目".repeat(index + 1)}/topic-${index}`;
    const rows: MoverWorktree[] = [{ path, branch: `topic-${index}`, locked: false, bare: false, lastVisited: null }];
    const picker = new MoverPicker(rows, "/elsewhere", theme, () => {}, () => {});
    const rendered = picker.render(60);
    assert.ok(rendered.some(line => line.includes(`topic-${index}`)));
    for (const line of rendered) assert.ok(visibleWidth(line) <= 60);
  }
});

test("Shift+Tab visibly toggles move/fork for keyboard and mouse, defaulting to move", () => {
  const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
  const trees: MoverWorktree[] = [{ path: "/repo/topic", branch: "topic", locked: false, bare: false, lastVisited: null }];
  const actions: MoverPickerAction[] = [];
  const picker = new MoverPicker(trees, "/repo/main", theme, action => actions.push(action), () => {});
  assert.ok(picker.render(80).some(line => line.includes("[Move]  Fork")));
  picker.handleInput("\x1b[Z");
  assert.ok(picker.render(80).some(line => line.includes("Move  [Fork]")));
  picker.handleInput("\r");
  assert.deepEqual(actions.pop(), { kind: "move", path: "/repo/topic", sessionMode: "fork" });
  picker.handleInput("\t");
  picker.handleInput("\x1b[Z");
  picker.handleMouse({ type: "press", button: "left", x: 4, y: 3, screenX: 4, screenY: 3, width: 80, height: 10, shift: false, alt: false, ctrl: false });
  assert.deepEqual(actions.pop(), { kind: "move", path: "/repo/topic", sessionMode: "move" });
  picker.handleInput("new-checkout");
  picker.handleInput("\x1b[Z");
  picker.handleInput("\x1b[13;2u");
  assert.deepEqual(actions.pop(), { kind: "create", name: "new-checkout", sessionMode: "fork" });
  picker.handleMouse({ type: "press", button: "left", x: 4, y: 3, screenX: 4, screenY: 3, width: 80, height: 10, shift: true, alt: false, ctrl: false });
  assert.deepEqual(actions.pop(), { kind: "create", name: "new-checkout", sessionMode: "fork" });
  const fresh = new MoverPicker(trees, "/repo/main", theme, () => {}, () => {});
  assert.ok(fresh.render(80).some(line => line.includes("[Move]  Fork")));
  for (const width of [20, 40, 80]) for (const line of picker.render(width)) assert.ok(visibleWidth(line) <= width);
});

test("fork creates a new session identity while preserving the selected branch and source", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-fork-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = SessionManager.create(directory, join(directory, "original"));
  original.appendMessage({ role: "user", content: "Selected", timestamp: 1 });
  const selected = original.getLeafId();
  original.appendMessage({ role: "user", content: "Abandoned", timestamp: 2 });
  const source = original.getSessionFile();
  assert.ok(source);
  await writeFile(source, [original.getHeader(), ...original.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const contents = await readFile(source, "utf8");
  const prepared = requireMoverValue(await prepareMoverSession({
    source, targetCwd: "/repo/fork", leafId: selected, mode: "fork", sessionDirectory: join(directory, "fork"),
  }));
  const fork = SessionManager.open(prepared.path);
  assert.equal(prepared.goal, "fork");
  assert.notEqual(fork.getSessionId(), original.getSessionId());
  assert.equal(fork.getHeader()?.parentSession, source);
  assert.equal(fork.getCwd(), "/repo/fork");
  assert.equal(fork.getBranch().filter(entry => entry.type === "message").length, 1);
  assert.equal(await readFile(source, "utf8"), contents);
});

test("an unsaved session creates a destination session for move and fork without a source file", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-unsaved-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const mode of ["move", "fork"] as const) {
    const original = SessionManager.create(directory, join(directory, mode, "original"));
    original.appendThinkingLevelChange("high");
    const source = original.getSessionFile();
    assert.ok(source);
    await assert.rejects(readFile(source), { code: "ENOENT" });
    const prepared = requireMoverValue(await prepareMoverSession({
      source, targetCwd: "/repo/new", leafId: original.getLeafId(), mode,
      sessionDirectory: join(directory, mode, "destination"), currentSession: original,
    }));
    assert.equal(prepared.source, undefined);
    const resumed = SessionManager.open(prepared.path);
    assert.equal(resumed.getCwd(), "/repo/new");
    assert.notEqual(resumed.getSessionId(), original.getSessionId());
    assert.ok(resumed.getBranch().some(entry => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"));
    await assert.rejects(readFile(source), { code: "ENOENT" });
  }
});

test("a missing saved conversation is not silently replaced by an empty session", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-missing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = SessionManager.create(directory, join(directory, "original"));
  original.appendMessage({ role: "user", content: "Do not lose this conversation", timestamp: 1 });
  const source = original.getSessionFile();
  assert.ok(source);
  await rm(source);
  for (const mode of ["move", "fork"] as const) {
    const result = await prepareMoverSession({
      source, targetCwd: "/repo/new", leafId: original.getLeafId(), mode,
      currentSession: original, sessionDirectory: join(directory, "destination"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /cannot safely recover an existing conversation/);
  }
});

test("Herdr startup failures retain workspace and session recovery information without focusing", async () => {
  const calls: string[][] = [];
  const herdr = new MoverHerdr({ async run(_command, args) {
    calls.push(args);
    return { code: 1, stdout: "", stderr: "agent_not_ready" };
  } }, "w1");
  const result = await herdr.startSession({ cwd: "/repo", workspaceId: "w2", paneId: "w2:p1", sessionPath: "/sessions/recovery.jsonl" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /w2/);
    assert.match(result.error.message, /recovery.jsonl/);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "agent");
});

test("move stages safely when the source is already in the destination session directory", async context => {
  const directory = await mkdtemp(join(tmpdir(), "pi-mover-same-directory-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const original = SessionManager.create("/repo/target", join(directory, "sessions"));
  original.appendMessage({ role: "user", content: "Keep selected history", timestamp: 1 });
  const selected = original.getLeafId();
  original.appendMessage({ role: "user", content: "Abandoned history", timestamp: 2 });
  const source = original.getSessionFile();
  assert.ok(source);
  const contents = await readFile(source, "utf8");
  const prepared = requireMoverValue(await prepareMoverSession({
    source, targetCwd: "/repo/target", leafId: selected, sessionDirectory: original.getSessionDir(),
  }));
  assert.notEqual(prepared.path, source);
  assert.equal(prepared.source, source);
  const resumed = SessionManager.open(prepared.path);
  assert.equal(resumed.getSessionId(), original.getSessionId());
  assert.equal(resumed.getCwd(), "/repo/target");
  assert.equal(resumed.getEntries().filter(entry => entry.type === "message").length, 2);
  assert.equal(resumed.getBranch().filter(entry => entry.type === "message").length, 1);
  assert.equal(await readFile(source, "utf8"), contents);
  // Cancellation removes only the staged copy, not the active source.
  await rm(prepared.path);
  assert.equal(await readFile(source, "utf8"), contents);
});
