import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HerdfastPicker } from "./herdfast-picker.ts";
import { HerdfastWorktrees, type HerdfastCommands, type HerdfastResult, type HerdfastWorktree } from "./herdfast-worktrees.ts";

function value<T>(result: HerdfastResult<T>): T { if (!result.ok) assert.fail(result.error.message); return result.value; }

function recordingHerdr() {
  const calls: string[][] = [];
  let closed = false;
  let failFocus = false;
  const commands: HerdfastCommands = { async run(args, cwd) {
    assert.equal(cwd, "/repo");
    calls.push(args);
    if (args[0] === "workspace") return { code: failFocus ? 1 : 0, stdout: JSON.stringify({ result: {} }), stderr: failFocus ? "Workspace closed" : "" };
    assert.deepEqual(args, ["worktree", "list", "--workspace", "w1"]);
    return { code: 0, stderr: "", stdout: JSON.stringify({ result: {
      source: { repo_key: "/repo/.git", repo_name: "project" },
      worktrees: [
        { path: "/repo", branch: "main", label: "project", open_workspace_id: "w1" },
        ...(!closed ? [{ path: "/repo-worktrees/topic", branch: "feature/topic", label: "Topic", open_workspace_id: "w2" }] : []),
        { path: "/repo-worktrees/closed", branch: "closed" },
        { path: "/repo.git", is_bare: true },
      ],
    } }) };
  } };
  return { commands, calls, close: () => { closed = true; }, fail: () => { failFocus = true; } };
}

test("open-only repository inventory marks current workspace and persists successful focus recency", async context => {
  const directory = await mkdtemp(join(tmpdir(), "herdfast-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cli = recordingHerdr();
  const service = new HerdfastWorktrees(cli.commands, directory, () => 100);
  const inventory = value(await service.list("/repo", "w1"));
  assert.deepEqual(inventory.worktrees.map(tree => tree.workspaceId), ["w1", "w2"]);
  assert.equal(inventory.worktrees[0]?.current, true);
  const topic = inventory.worktrees[1];
  assert.ok(topic);
  value(await service.focus("/repo", "w1", topic));
  assert.deepEqual(cli.calls.at(-1), ["workspace", "focus", "w2"]);
  // A fresh service in another caller workspace reads the same on-disk history.
  const otherCommands: HerdfastCommands = { async run(args) {
    assert.deepEqual(args, ["worktree", "list", "--workspace", "w3"]);
    return cli.commands.run(["worktree", "list", "--workspace", "w1"], "/repo");
  } };
  const reopened = new HerdfastWorktrees(otherCommands, directory, () => 100);
  assert.deepEqual(value(await reopened.list("/repo", "w3")).worktrees.map(tree => tree.workspaceId), ["w2", "w1"]);
  assert.ok(cli.calls.every(args => args[0] !== "agent" && args[1] !== "create"));
});

test("stale worktrees and failed focus return errors without recording a successful target visit", async context => {
  const directory = await mkdtemp(join(tmpdir(), "herdfast-stale-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cli = recordingHerdr();
  const service = new HerdfastWorktrees(cli.commands, directory, () => 100);
  const topic = value(await service.list("/repo", "w1")).worktrees[1];
  assert.ok(topic);
  cli.fail();
  const failed = await service.focus("/repo", "w1", topic);
  assert.equal(failed.ok, false);
  assert.equal(value(await service.list("/repo", "w1")).worktrees[1]?.visitedAt, 0);
  cli.close();
  const count = cli.calls.filter(args => args[0] === "workspace").length;
  assert.equal((await service.focus("/repo", "w1", topic)).ok, false);
  assert.equal(cli.calls.filter(args => args[0] === "workspace").length, count);
});

test("current selection is a no-op and malformed CLI responses are rejected", async context => {
  const directory = await mkdtemp(join(tmpdir(), "herdfast-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cli = recordingHerdr();
  const service = new HerdfastWorktrees(cli.commands, directory, () => 100);
  const current = value(await service.list("/repo", "w1")).worktrees[0];
  assert.ok(current);
  value(await service.focus("/repo", "w1", current));
  assert.ok(cli.calls.every(args => args[0] !== "workspace"));
  for (const stdout of ["invalid", "{}", JSON.stringify({ result: { source: {}, worktrees: [] } })]) {
    const invalid = new HerdfastWorktrees({ run: async () => ({ code: 0, stdout, stderr: "" }) }, directory, () => 100);
    assert.equal((await invalid.list("/repo", "w1")).ok, false);
  }
});

test("picker searches branches, paths and labels without reranking recency; Enter selects and Esc cancels", () => {
  const selected: Array<HerdfastWorktree | undefined> = [];
  const trees: HerdfastWorktree[] = [
    { workspaceId: "w2", path: "/项目/recent", label: "Shared recent", branch: "feature/recent", current: false, visitedAt: 200 },
    { workspaceId: "w1", path: "/项目/old", label: "Shared old", branch: "main", current: true, visitedAt: 100 },
  ];
  const make = () => new HerdfastPicker({ repoKey: "/repo/.git", repoName: "项目", worktrees: trees }, { fg: (_color, text) => text }, tree => selected.push(tree), () => {});
  const picker = make();
  picker.focused = true;
  assert.equal(picker.focused, true);
  assert.ok(picker.render(80).some(line => line.includes("[active]")));
  picker.handleInput("shared");
  picker.handleInput("\r");
  assert.equal(selected.pop()?.workspaceId, "w2");
  const branch = make();
  branch.handleInput("MAIN");
  branch.handleInput("\r");
  assert.equal(selected.pop()?.workspaceId, "w1");
  const path = make();
  path.handleInput("/项目/old");
  path.handleInput("\r");
  assert.equal(selected.pop()?.workspaceId, "w1");
  const missing = make();
  missing.handleInput("not-open");
  missing.handleInput("\r");
  assert.equal(selected.length, 0);
  assert.ok(missing.render(80).some(line => line.includes("No matching open worktrees")));
  missing.handleInput("\x1b");
  assert.deepEqual(selected, [undefined]);
  for (const width of [10, 20, 40, 80]) for (const line of picker.render(width)) assert.ok(visibleWidth(line) <= width);
});
