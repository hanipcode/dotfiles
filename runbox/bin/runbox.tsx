#!/usr/bin/env bun

import { Args, Command, Options, Prompt } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { bootstrap, daemonForward, daemonRequest, ensureDaemonConfigured, sourceRef } from "../src/client.ts"
import { ensureCommitted, type CommitOptions } from "../src/commit.ts"
import type { ProjectContext, RepoSnapshot } from "../src/domain.ts"
import { commandId, repositoryRoot, sameSource } from "../src/domain.ts"
import { RunboxError, toErrorInfo } from "../src/errors.ts"
import { formatLogOutput } from "../src/logFormat.ts"
import { ApplicationLayer, CoreLayer } from "../src/layers.ts"
import { RunboxApplication } from "../src/application/RunboxApplication.ts"
import { GhStack } from "../src/services/GhStack.ts"
import { Paths } from "../src/services/Paths.ts"
import { Project } from "../src/services/Project.ts"
import { StateStore } from "../src/services/StateStore.ts"
import { Registry } from "../src/services/Registry.ts"
import { LogStore } from "../src/services/LogStore.ts"
import { Shell } from "../src/services/Shell.ts"
import { ownsPersistedProcess } from "../src/services/Supervisor.ts"
import { openGlobalDashboard } from "../src/ui/openGlobalDashboard.tsx"

const scriptArg = Args.text({ name: "script" }).pipe(Args.optional)
const scriptArgs = Args.text({ name: "args" }).pipe(Args.repeated)
const jsonOption = Options.boolean("json")
const noTuiOption = Options.boolean("no-tui")
const agentCommitOption = Options.boolean("agent-commit")
const commitMessageOption = Options.text("commit-message").pipe(Options.optional)
const linesOption = Options.integer("lines").pipe(Options.withDefault(200))
const environmentSourceOption = Options.text("environment-source").pipe(Options.optional)
const watchOption = Options.boolean("watch").pipe(Options.withAlias("w"))
const executableArg = Args.text({ name: "executable" })
const commandArgs = Args.text({ name: "args" }).pipe(Args.repeated)
const FORWARD_CAPTURE_LIMIT = 64 * 1024

const safe = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  json = false,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchAll((error) => {
      const info = toErrorInfo(error)
      return (json
        ? Console.log(JSON.stringify({ ok: false, error: info }, null, 2))
        : Console.error(
            `runbox: ${info.code}: ${info.message}\n\nsuggestion: ${info.suggestion}${
              info.details === null ? "" : `\n\ndetails:\n${info.details}`
            }`,
          )).pipe(
        Effect.tap(() => Effect.sync(() => { process.exitCode = 1 })),
      )
    }),
  )

const printJson = (command: string, data: unknown) =>
  Console.log(JSON.stringify({ ok: true, command, data }, null, 2))

const withPreparationProgress = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  json: boolean,
  action: string,
): Effect.Effect<A, E, R> => {
  if (json || process.stderr.isTTY !== true) return effect
  return Effect.gen(function* () {
    const cleanup = yield* Effect.sync(() => {
      const frames = ["|", "/", "-", "\\"] as const
      const startedAt = Date.now()
      let frame = 0
      const render = () => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1_000)
        process.stderr.write(`\r\u001b[2K${frames[frame]} ${action} (${elapsed}s)`)
        frame = (frame + 1) % frames.length
      }
      render()
      const timer = setInterval(render, 120)
      return () => {
        clearInterval(timer)
        process.stderr.write("\r\u001b[2K")
      }
    })
    return yield* effect.pipe(Effect.ensuring(Effect.sync(cleanup)))
  })
}

const discover = Effect.fn("Cli.discover")(function* () {
  const projects = yield* Project
  return yield* projects.discover(process.cwd())
})

const initializeClient = Effect.fn("Cli.initializeClient")(function* (
  project: ProjectContext,
  environmentSourceRoot?: string,
) {
  const state = yield* bootstrap(project, environmentSourceRoot)
  const socket = yield* ensureDaemonConfigured(project, state)
  return { state, socket }
})

const requireSnapshot = (response: { readonly snapshot?: RepoSnapshot | undefined }): Effect.Effect<RepoSnapshot, RunboxError> =>
  response.snapshot === undefined
    ? Effect.fail(new RunboxError({ operation: "read daemon state", message: "daemon returned no snapshot" }))
    : Effect.succeed(response.snapshot)

const printSnapshot = (snapshot: RepoSnapshot, json: boolean, command: string) =>
  json
    ? printJson(command, snapshot)
    : Effect.gen(function* () {
        const source = snapshot.state.source
        yield* Console.log(
          source?.stack === null || source?.stack === undefined
            ? `runbox ${source?.branch ?? "detached"}@${source?.commit.slice(0, 8) ?? "unknown"}`
            : `runbox stack ${source.stack.trunk} > ${source.stack.branches.map((branch) => branch.name).join(" > ")} [top: ${source.stack.topBranch}]`,
        )
        for (const record of Object.values(snapshot.state.commands)) {
          const metric = snapshot.metrics[record.id]
          const usage = metric === undefined
            ? ""
            : ` ${metric.cpuPercent.toFixed(1)}% ${(metric.memoryBytes / 1024 / 1024).toFixed(1)}M`
          yield* Console.log(`${record.id} ${record.status}${usage}`)
        }
      })

const waitForCommand = Effect.fn("Cli.waitForCommand")(function* (
  socket: string,
  packagePath: string,
  id: string,
) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const snapshot = yield* daemonRequest(socket, { type: "status", packagePath }).pipe(
      Effect.flatMap(requireSnapshot),
    )
    const record = snapshot.state.commands[id]
    if (record?.status === "running" || record?.status === "completed") return snapshot
    if (record?.status === "failed") {
      yield* Effect.sleep(250)
      const confirmation = yield* daemonRequest(socket, { type: "status", packagePath }).pipe(
        Effect.flatMap(requireSnapshot),
      )
      const current = confirmation.state.commands[id]
      if (current?.status !== "failed") continue
      return yield* new RunboxError({
        operation: `start ${record.script}`,
        message: current.message ?? "command failed during startup",
        code: "COMMAND_FAILED",
        suggestion: "Inspect the retained command log and retry after correcting the startup failure.",
        retryable: true,
      })
    }
    yield* Effect.sleep(100)
  }
  return yield* new RunboxError({
    operation: "wait for command startup",
    message: "command did not start within ten minutes",
    code: "PREPARATION_TIMEOUT",
    suggestion: "Inspect runbox logs and retry the command.",
    retryable: true,
  })
})

const runScript = Effect.fn("Cli.runScript")(function* (
  script: string,
  args: ReadonlyArray<string>,
  options: CommitOptions & { readonly json: boolean; readonly watch: boolean },
) {
  let project = yield* discover()
  const projects = yield* Project
  yield* projects.requireScript(project, script)
  if (!options.watch && (yield* ensureCommitted(project, { ...options, noTui: options.noTui || options.json }))) {
    project = yield* projects.discover(process.cwd())
  }
  const { socket } = yield* initializeClient(project)
  const request = {
    type: "activate",
    packagePath: project.packagePath,
    script,
    args,
    source: sourceRef(project),
    watch: options.watch,
  } as const
  if (options.watch || options.json || options.noTui || !process.stdout.isTTY) {
    yield* daemonRequest(socket, request)
    const snapshot = yield* withPreparationProgress(
      waitForCommand(socket, project.packagePath, commandId(project.packagePath, script)),
      options.json,
      `Starting ${script}`,
    )
    yield* printSnapshot(snapshot, options.json, "run")
  } else {
    yield* openGlobalDashboard({
      query: {
        repositoryId: project.repoId,
        worktreePath: project.repoRoot,
        commandId: commandId(project.packagePath, script),
      },
      initialIntent: {
        type: "run",
        repoId: project.repoId,
        worktreePath: project.repoRoot,
        expectedHead: project.commit,
        packagePath: project.packagePath,
        script,
        args,
      },
    }).pipe(Effect.provide(ApplicationLayer))
  }
})

const root = Command.make(
  "runbox",
  {
    script: scriptArg,
    args: scriptArgs,
    json: jsonOption,
    noTui: noTuiOption,
    agentCommit: agentCommitOption,
    commitMessage: commitMessageOption,
    watch: watchOption,
  },
  ({ agentCommit, args, commitMessage, json, noTui, script, watch }) =>
    safe(Option.isSome(script)
      ? runScript(script.value, args, { noTui, json, agentCommit, commitMessage, watch })
      : Effect.gen(function* () {
          if (!json && !noTui && process.stdout.isTTY) return yield* openGlobalDashboard()
          const application = yield* RunboxApplication
          const view = yield* application.inspect()
          if (json) yield* Console.log(JSON.stringify({ ok: true, command: "projects", data: view }, null, 2))
          else {
            for (const repository of view.repositories) {
              yield* Console.log(`${repository.name}  ${repository.activeCommandCount} active  ${repository.storage}`)
            }
          }
        }).pipe(Effect.provide(ApplicationLayer)), json),
).pipe(Command.withDescription("Run package scripts from one managed Git worktree"))

const explicitScript = Args.text({ name: "script" })
const runCommand = Command.make(
  "run",
  {
    script: explicitScript,
    args: scriptArgs,
    json: jsonOption,
    noTui: noTuiOption,
    agentCommit: agentCommitOption,
    commitMessage: commitMessageOption,
    watch: watchOption,
  },
  ({ agentCommit, args, commitMessage, json, noTui, script, watch }) =>
    safe(runScript(script, args, { noTui, json, agentCommit, commitMessage, watch }), json),
).pipe(Command.withDescription("Run a script whose name collides with a runbox command"))

const syncCommand = Command.make(
  "sync",
  { json: jsonOption },
  ({ json }) => safe(Effect.gen(function* () {
    const project = yield* discover()
    const { socket } = yield* initializeClient(project)
    const response = yield* daemonRequest(socket, {
      type: "sync",
      packagePath: project.packagePath,
      source: sourceRef(project),
    })
    if (response.sync === undefined) {
      return yield* new RunboxError({
        operation: "synchronize source worktree",
        message: "daemon returned no sync result",
        code: "INVALID_RESPONSE",
        suggestion: "Upgrade runbox and retry.",
      })
    }
    if (json) yield* printJson("sync", response.sync)
    else yield* Console.log(
      `Synced ${response.sync.copied} copied, ${response.sync.removed} removed from ${response.sync.sourcePath}`,
    )
  }), json),
).pipe(Command.withDescription("Synchronize uncommitted source changes into the managed runner"))

const appendCapture = (
  capture: { value: string; truncated: boolean },
  text: string,
): void => {
  const combined = capture.value + text
  if (combined.length > FORWARD_CAPTURE_LIMIT) {
    capture.value = combined.slice(-FORWARD_CAPTURE_LIMIT)
    capture.truncated = true
  } else {
    capture.value = combined
  }
}

const forwardCommand = Command.make(
  "forward",
  {
    executable: executableArg,
    args: commandArgs,
    json: jsonOption,
    noTui: noTuiOption,
    agentCommit: agentCommitOption,
    commitMessage: commitMessageOption,
  },
  ({ agentCommit, args, commitMessage, executable, json, noTui }) =>
    safe(Effect.gen(function* () {
      let project = yield* discover()
      const projects = yield* Project
      if (yield* ensureCommitted(project, {
        noTui: noTui || json,
        agentCommit,
        commitMessage,
      })) {
        project = yield* projects.discover(process.cwd())
      }
      const { socket } = yield* initializeClient(project)
      const stdout = { value: "", truncated: false }
      const stderr = { value: "", truncated: false }
      const result = yield* daemonForward(socket, {
        type: "forward",
        packagePath: project.packagePath,
        argv: [executable, ...args],
        source: sourceRef(project),
      }, {
        onStart: () => {},
        onOutput: (stream, text) => {
          if (json) appendCapture(stream === "stdout" ? stdout : stderr, text)
          else if (stream === "stdout") process.stdout.write(text)
          else process.stderr.write(text)
        },
      })
      const data = {
        ...result,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      }
      if (json) {
        if (result.exitCode === 0 && result.signal === null) {
          yield* printJson("forward", data)
        } else {
          yield* Console.log(JSON.stringify({
            ok: false,
            command: "forward",
            data,
            error: {
              code: result.signal === null ? "FORWARDED_COMMAND_FAILED" : "FORWARD_INTERRUPTED",
              message: result.signal === null
                ? `${JSON.stringify(result.argv)} exited with ${result.exitCode}`
                : `${JSON.stringify(result.argv)} was terminated by ${result.signal}`,
              operation: "execute forwarded command",
              suggestion: "Inspect data.stdout, data.stderr, and 'runbox logs forward --json'. Correct the underlying cause before retrying.",
              retryable: false,
              details: null,
            },
          }, null, 2))
        }
      } else {
        for (const warning of result.warnings) {
          yield* Console.error(`runbox: ${warning.code}: ${warning.message}`)
        }
      }
      if (result.exitCode !== 0 || result.signal !== null) {
        yield* Effect.sync(() => {
          process.exitCode = result.exitCode > 0 ? result.exitCode : 1
        })
      }
    }), json),
).pipe(Command.withDescription("Run a synchronous one-off command in the managed runner"))

const stackCommand = Command.make(
  "stack",
  {
    script: explicitScript,
    args: scriptArgs,
    json: jsonOption,
    noTui: noTuiOption,
  },
  ({ args, json, noTui, script }) =>
    safe(Effect.gen(function* () {
      const project = yield* discover()
      const projects = yield* Project
      const stacks = yield* GhStack
      const source = yield* stacks.resolveTop(project)
      yield* projects.requireScriptAt(project, source.commit, script)
      const { socket } = yield* initializeClient(project)
      const request = {
        type: "activate",
        packagePath: project.packagePath,
        script,
        args,
        source,
      } as const
      if (json || noTui || !process.stdout.isTTY) {
        yield* daemonRequest(socket, request)
        const snapshot = yield* withPreparationProgress(
          waitForCommand(socket, project.packagePath, commandId(project.packagePath, script)),
          json,
          `Activating stack command ${script}`,
        )
        yield* printSnapshot(snapshot, json, "stack")
      } else {
        yield* daemonRequest(socket, request)
        yield* openGlobalDashboard({
          query: {
            repositoryId: project.repoId,
            ...(source.worktreePath === null ? {} : { worktreePath: source.worktreePath }),
            commandId: commandId(project.packagePath, script),
          },
        }).pipe(Effect.provide(ApplicationLayer))
      }
    }), json),
).pipe(Command.withDescription("Run a command from the highest active branch in the current gh stack"))

const stopTarget = Args.text({ name: "command" })
const stopCommand = Command.make("stop", { target: stopTarget, json: jsonOption }, ({ json, target }) =>
  safe(Effect.gen(function* () {
    const project = yield* discover()
    const { socket } = yield* initializeClient(project)
    const response = yield* daemonRequest(socket, {
      type: "stop",
      packagePath: project.packagePath,
      script: target,
    })
    const snapshot = yield* requireSnapshot(response)
    yield* printSnapshot(snapshot, json, "stop")
  }), json),
).pipe(Command.withDescription("Stop a command, or all commands in this repository"))

const statusCommand = Command.make("status", { json: jsonOption }, ({ json }) =>
  safe(Effect.gen(function* () {
    const project = yield* discover()
    const { socket } = yield* initializeClient(project)
    const response = yield* daemonRequest(socket, {
      type: "status",
      packagePath: project.packagePath,
    })
    yield* printSnapshot(yield* requireSnapshot(response), json, "status")
  }), json),
).pipe(Command.withDescription("Show runner and process state"))

const commandsCommand = Command.make("commands", { json: jsonOption }, ({ json }) =>
  safe(Effect.gen(function* () {
    const project = yield* discover()
    const projects = yield* Project
    const info = yield* projects.packageInfo(project)
    const commands = yield* Effect.forEach(Object.entries(info.scripts), ([name, value]) => {
      const instructionPath = join(
        project.repoRoot,
        ".agents",
        "runbox",
        "instructions",
        project.packagePath,
        name,
      )
      return Effect.promise(() => access(instructionPath).then(
        () => ({ name, value, instructionPath, hasInstruction: true }),
        () => ({ name, value, instructionPath, hasInstruction: false }),
      ))
    })
    const data = {
      project: basename(project.repoRoot),
      repoId: project.repoId,
      repoRoot: project.repoRoot,
      packagePath: project.packagePath,
      packageManager: info.manager,
      commands: commands.sort((left, right) => left.name.localeCompare(right.name)),
    }
    if (json) yield* printJson("commands", data)
    else {
      yield* Console.log(`${data.project} (${data.packageManager}) ${data.packagePath || "."}`)
      for (const command of data.commands) {
        yield* Console.log(`${command.name}${command.hasInstruction ? "  [prepared]" : ""}\n  ${command.value}`)
      }
    }
  }), json),
).pipe(Command.withDescription("List package scripts and runbox preparation instructions"))

const projectsCommand = Command.make("projects", { json: jsonOption }, ({ json }) =>
  safe(Effect.gen(function* () {
    const registry = yield* Registry
    const states = yield* registry.list()
    const projects = states.map((state) => {
      const commands = Object.values(state.commands).map((record) => {
        const alive = ownsPersistedProcess(record)
        return {
          id: record.id,
          script: record.script,
          packagePath: record.packagePath,
          status: record.status,
          pid: record.pid,
          alive,
          sourceWatch: record.sourceWatch ?? false,
        }
      })
      return {
        name: basename(repositoryRoot(state)),
        key: `${basename(repositoryRoot(state))}#${state.repoId}`,
        repoId: state.repoId,
        repoRoot: state.repoRoot,
        environmentSourceRoot: state.environmentSourceRoot,
        runnerPath: state.runnerPath,
        source: state.source,
        runningCommands: commands.filter((command) => command.alive),
        commands,
      }
    })
    if (json) yield* printJson("projects", { projects })
    else if (projects.length === 0) yield* Console.log("No runbox projects have been initialized.")
    else {
      for (const project of projects) {
        const running = project.runningCommands.length === 0
          ? "no running commands"
          : project.runningCommands.map((command) => `${command.id} (pid ${command.pid})`).join(", ")
        yield* Console.log(`${project.key}\n  ${project.environmentSourceRoot ?? project.repoRoot}\n  ${running}`)
      }
    }
  }), json),
).pipe(Command.withDescription("List every known runbox project and its running commands"))

const projectOrCommandArg = Args.text({ name: "project-or-command" })
const optionalCommandArg = Args.text({ name: "command" }).pipe(Args.optional)

const resolveRegistryTarget = Effect.fn("Cli.resolveRegistryTarget")(function* (
  projectOrCommand: string,
  command: Option.Option<string>,
) {
  const registry = yield* Registry
  const store = yield* StateStore
  if (Option.isSome(command)) {
    const state = yield* registry.resolve(projectOrCommand)
    return { state, command: command.value }
  }
  const project = yield* discover()
  const state = yield* store.load(project)
  return { state, command: projectOrCommand }
})

const logsCommand = Command.make(
  "logs",
  {
    projectOrCommand: projectOrCommandArg,
    command: optionalCommandArg,
    lines: linesOption,
    json: jsonOption,
  },
  ({ command, json, lines, projectOrCommand }) =>
    safe(Effect.gen(function* () {
      const registry = yield* Registry
      const logs = yield* LogStore
      const paths = yield* Paths
      const target = yield* resolveRegistryTarget(projectOrCommand, command)
      const artifact = ["setup", "history", "instructions", "forward", "sync"].includes(target.command)
      const record = artifact
        ? null
        : yield* registry.command(target.state, target.command)
      const logFile = record?.logFile ?? (
        target.command === "history"
          ? paths.historyFile(target.state.repoId)
          : target.command === "instructions"
            ? paths.instructionsFile(target.state.repoId)
            : join(
                paths.repoState(target.state.repoId),
                "logs",
                target.command === "forward"
                  ? "forward.log"
                  : target.command === "sync" ? "sync.log" : "setup.log",
              )
      )
      const retained = yield* logs.tail(logFile)
      const lineLimit = Math.max(1, lines)
      const selected = formatLogOutput(retained).replace(/\n+$/, "").split("\n").slice(-lineLimit).join("\n")
      const data = {
        project: {
          name: basename(repositoryRoot(target.state)),
          key: `${basename(repositoryRoot(target.state))}#${target.state.repoId}`,
          repoId: target.state.repoId,
          repoRoot: target.state.repoRoot,
          environmentSourceRoot: target.state.environmentSourceRoot,
        },
        command: record === null
          ? { id: target.command, script: target.command, packagePath: "", status: null, pid: null }
          : {
              id: record.id,
              script: record.script,
              packagePath: record.packagePath,
              status: record.status,
              pid: record.pid,
            },
        source: target.state.source,
        logFile,
        lineLimit,
        log: selected,
        suggestion: selected.trim() === ""
          ? "No retained output is available yet. Start or restart the command, then retry."
          : null,
      }
      if (json) yield* printJson("logs", data)
      else yield* Console.log(
        `${data.project.key} ${data.command.id} ${data.command.status ?? ""}\n${
          selected.trim() === "" ? data.suggestion : selected
        }`,
      )
    }), json),
).pipe(Command.withDescription("Read retained setup or command logs locally or by global project name"))

const restartCommand = Command.make(
  "restart",
  { projectOrCommand: projectOrCommandArg, command: optionalCommandArg, json: jsonOption },
  ({ command, json, projectOrCommand }) =>
    safe(Effect.gen(function* () {
      const registry = yield* Registry
      const projects = yield* Project
      const target = yield* resolveRegistryTarget(projectOrCommand, command)
      const record = yield* registry.command(target.state, target.command)
      const project = yield* projects.discover(join(repositoryRoot(target.state), record.packagePath))
      const { socket } = yield* initializeClient(project)
      yield* daemonRequest(socket, {
        type: "restart",
        packagePath: record.packagePath,
        script: record.script,
      })
      const snapshot = yield* waitForCommand(socket, record.packagePath, record.id)
      yield* printSnapshot(snapshot, json, "restart")
    }), json),
).pipe(Command.withDescription("Restart a tracked command locally or by global project name"))

const optionalProjectArg = Args.text({ name: "project" }).pipe(Args.optional)

const doctorCommand = Command.make(
  "doctor",
  { project: optionalProjectArg, json: jsonOption },
  ({ json, project: projectQuery }) =>
    safe(Effect.gen(function* () {
      const projects = yield* Project
      const registry = yield* Registry
      const store = yield* StateStore
      const shell = yield* Shell
      const paths = yield* Paths
      const selection = Option.isSome(projectQuery)
        ? { state: yield* registry.resolve(projectQuery.value), localContext: null }
        : yield* Effect.gen(function* () {
            const localContext = yield* discover()
            const state = yield* store.load(localContext)
            return { state, localContext }
          })
      const { state, localContext } = selection
      const sample = Object.values(state.commands)[0]
      const context = localContext ?? (yield* projects.discover(
        sample === undefined ? repositoryRoot(state) : join(repositoryRoot(state), sample.packagePath),
      ))
      const info = yield* projects.packageInfo(context)
      const checks: Array<{
        name: string
        status: "ok" | "warning" | "error"
        message: string
        suggestion: string | null
      }> = []

      const executableCheck = Effect.fn("Doctor.executable")(function* (
        name: string,
        executable: string,
        required: boolean,
        suggestion: string,
      ) {
        const result = yield* shell.run(["/usr/bin/which", executable], {
          cwd: context.repoRoot,
          allowFailure: true,
        }).pipe(
          Effect.mapError((error) =>
            new RunboxError({ operation: `check ${name}`, message: error.stderr }),
          ),
        )
        checks.push(result.exitCode === 0
          ? { name, status: "ok", message: result.stdout.trim(), suggestion: null }
          : { name, status: required ? "error" : "warning", message: `${executable} is not installed`, suggestion })
      })

      yield* executableCheck(
        "package-manager",
        info.manager,
        true,
        `Install ${info.manager}; this project was detected from packageManager or its lockfile.`,
      )
      yield* executableCheck(
        "opencode",
        process.env.RUNBOX_OPENCODE_BIN ?? "opencode",
        true,
        "Install OpenCode and authenticate openai/gpt-5.6-luna.",
      )
      yield* executableCheck(
        "github-cli",
        process.env.RUNBOX_GH_BIN ?? "gh",
        false,
        "Install GitHub CLI and 'gh extension install github/gh-stack' to use runbox stack.",
      )
      const ghExecutable = process.env.RUNBOX_GH_BIN ?? "gh"
      const ghStack = yield* shell.run([ghExecutable, "extension", "list"], {
        cwd: context.repoRoot,
        allowFailure: true,
      }).pipe(Effect.option)
      const hasGhStack = ghStack._tag === "Some" &&
        ghStack.value.exitCode === 0 &&
        ghStack.value.stdout.includes("gh-stack")
      checks.push(hasGhStack
        ? { name: "gh-stack", status: "ok", message: "gh-stack is installed", suggestion: null }
        : {
            name: "gh-stack",
            status: "warning",
            message: "gh-stack extension is unavailable",
            suggestion: "Install it with 'gh extension install github/gh-stack' to use runbox stack.",
          })

      const runnerExists = yield* Effect.promise(() => access(state.runnerPath).then(() => true, () => false))
      checks.push(runnerExists
        ? { name: "runner", status: "ok", message: state.runnerPath, suggestion: null }
        : {
            name: "runner",
            status: "warning",
            message: "managed worktree has not been created",
            suggestion: "Run 'runbox init' or start a package command.",
          })
      const environmentSourceExists = state.environmentSourceRoot !== null &&
        (yield* Effect.promise(() => access(state.environmentSourceRoot ?? "").then(() => true, () => false)))
      checks.push(environmentSourceExists
        ? { name: "environment-source", status: "ok", message: state.environmentSourceRoot ?? "", suggestion: null }
        : {
            name: "environment-source",
            status: "warning",
            message: state.environmentSourceRoot === null
              ? "environment source has not been recorded"
              : `environment source does not exist: ${state.environmentSourceRoot}`,
            suggestion: "Run 'runbox init --environment-source <path>' with a canonical source worktree.",
          })
      const setupPath = join(repositoryRoot(state), ".agents", "runbox", "setup.md")
      const hasSetup = yield* Effect.promise(() => access(setupPath).then(() => true, () => false))
      checks.push(hasSetup
        ? { name: "setup-instructions", status: "ok", message: setupPath, suggestion: null }
        : {
            name: "setup-instructions",
            status: "warning",
            message: "project has no .agents/runbox/setup.md",
            suggestion: "Run 'runbox init' to create project-owned setup guidance.",
          })
      for (const [name, path] of [
        ["run-history", paths.historyFile(state.repoId)],
        ["living-instructions", paths.instructionsFile(state.repoId)],
      ] as const) {
        const memory = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8").then(
            (raw) => {
              const lines = raw.split("\n")
              if (!raw.endsWith("\n")) lines.pop()
              for (const line of lines.filter((entry) => entry.trim() !== "")) JSON.parse(line)
              return { exists: true }
            },
            (cause: NodeJS.ErrnoException) => cause.code === "ENOENT"
              ? { exists: false }
              : Promise.reject(cause),
          ),
          catch: () => new RunboxError({ operation: `validate ${name}`, message: `${path} contains invalid JSONL` }),
        }).pipe(Effect.either)
        checks.push(memory._tag === "Left"
          ? {
              name,
              status: "error",
              message: `${path} contains invalid JSONL`,
              suggestion: `Inspect '${path}' and remove only the malformed record.`,
            }
          : {
              name,
              status: memory.right.exists ? "ok" : "warning",
              message: memory.right.exists ? path : `${name} has not been created yet`,
              suggestion: memory.right.exists ? null : "Run setup or start a command to create preparation memory.",
            })
      }
      const syncJournalPath = join(paths.repoState(state.repoId), "sync.json")
      const syncJournal = yield* Effect.tryPromise({
        try: () => readFile(syncJournalPath, "utf8").then(
          (raw) => {
            const parsed = JSON.parse(raw) as { version?: unknown }
            if (parsed.version !== 1) throw new Error("unsupported sync journal version")
            return { exists: true, valid: true }
          },
          (cause: NodeJS.ErrnoException) => cause.code === "ENOENT"
            ? { exists: false, valid: true }
            : Promise.reject(cause),
        ),
        catch: () => new RunboxError({
          operation: "validate sync journal",
          message: `${syncJournalPath} contains invalid synchronization state`,
        }),
      }).pipe(Effect.either)
      checks.push(syncJournal._tag === "Left"
        ? {
            name: "source-sync",
            status: "error",
            message: syncJournal.left.message,
            suggestion: "Inspect the sync journal and 'runbox logs sync --json' before removing only the invalid journal.",
          }
        : {
            name: "source-sync",
            status: syncJournal.right.exists ? "ok" : "warning",
            message: syncJournal.right.exists ? syncJournalPath : "source synchronization has not run yet",
            suggestion: syncJournal.right.exists ? null : "Run 'runbox sync --json' when dirty-worktree synchronization is needed.",
          })
      const socketPath = paths.socket(state.repoId)
      const daemonRunning = yield* Effect.promise(() => access(socketPath).then(() => true, () => false))
      checks.push(daemonRunning
        ? { name: "daemon", status: "ok", message: socketPath, suggestion: null }
        : {
            name: "daemon",
            status: "warning",
            message: "no daemon is currently attached",
            suggestion: "This is normal when no commands are running; start a command to launch it.",
          })
      for (const record of Object.values(state.commands)) {
        if (record.pid === null) continue
        const alive = yield* Effect.sync(() => ownsPersistedProcess(record))
        if (!alive && ["preparing", "starting", "running", "stopping"].includes(record.status)) {
          checks.push({
            name: `process:${record.id}`,
            status: "warning",
            message: `state says ${record.status}, but pid ${record.pid} is not alive`,
            suggestion: `Run 'runbox restart ${record.id} --json' from this project.`,
          })
        }
      }

      const healthy = checks.every((check) => check.status !== "error")
      const data = {
        healthy,
        project: {
          name: basename(repositoryRoot(state)),
          key: `${basename(repositoryRoot(state))}#${state.repoId}`,
          repoId: state.repoId,
          repoRoot: state.repoRoot,
          environmentSourceRoot: state.environmentSourceRoot,
        },
        packagePath: context.packagePath,
        packageManager: info.manager,
        source: state.source,
        stateFile: paths.stateFile(state.repoId),
        daemonLog: join(paths.repoState(state.repoId), "daemon.log"),
        checks,
      }
      if (json && !healthy) {
        return yield* new RunboxError({
          operation: "diagnose runbox project",
          message: "one or more required doctor checks failed",
          code: "DOCTOR_FAILED",
          suggestion: "Apply the suggestions in error.details, then rerun 'runbox doctor --json'.",
          details: JSON.stringify(data),
        })
      }
      if (json) yield* printJson("doctor", data)
      else {
        for (const check of checks) {
          yield* Console.log(`${check.status.padEnd(7)} ${check.name}: ${check.message}${
            check.suggestion === null ? "" : `\n         suggestion: ${check.suggestion}`
          }`)
        }
      }
      if (!healthy) yield* Effect.sync(() => { process.exitCode = 1 })
    }), json),
).pipe(Command.withDescription("Diagnose a local or globally named runbox project without modifying it"))

const switchCommand = Command.make(
  "switch",
  {
    json: jsonOption,
    noTui: noTuiOption,
    agentCommit: agentCommitOption,
    commitMessage: commitMessageOption,
  },
  ({ agentCommit, commitMessage, json, noTui }) =>
    safe(Effect.gen(function* () {
      const projects = yield* Project
      let project = yield* projects.discover(process.cwd())
      if (yield* ensureCommitted(project, {
        noTui: noTui || json,
        agentCommit,
        commitMessage,
      })) {
        project = yield* projects.discover(process.cwd())
      }
      const { socket } = yield* initializeClient(project)
      if (!json) yield* Console.log(`Switching runner to ${project.branch ?? project.commit.slice(0, 8)}...`)
      const response = yield* withPreparationProgress(
        daemonRequest(socket, { type: "switch", source: sourceRef(project) }),
        json,
        "Switching source",
      )
      if (json) yield* printJson("switch", response)
      else yield* Console.log(response.message ?? "switched")
    }), json),
).pipe(Command.withDescription("Switch the managed runner to this worktree's committed HEAD"))

const instructionScripts = Effect.fn("Init.instructionScripts")(function* (project: ProjectContext) {
  const directory = join(
    project.repoRoot,
    ".agents",
    "runbox",
    "instructions",
    project.packagePath,
  )
  return yield* Effect.promise(() =>
    readdir(directory, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isFile()).map((entry) => entry.name), () => []),
  )
})

interface InitDraft {
  readonly setup: string
  readonly scripts: ReadonlyArray<string>
  readonly instructions: Readonly<Record<string, string>>
}

const writeAtomic = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

const initCommand = Command.make("init", { environmentSource: environmentSourceOption }, ({ environmentSource }) =>
  safe(Effect.gen(function* () {
    const projects = yield* Project
    let project = yield* projects.discover(process.cwd())
    const info = yield* projects.packageInfo(project)
    const setupPath = join(project.repoRoot, ".agents", "runbox", "setup.md")
    const draftPath = join(project.repoRoot, ".agents", "runbox", ".init.json")
    const hasSetup = yield* Effect.promise(() => access(setupPath).then(() => true, () => false))
    let scripts = yield* instructionScripts(project)
    let shouldBootstrap = hasSetup

    if (!hasSetup) {
      let draft = yield* Effect.tryPromise({
        try: () => readFile(draftPath, "utf8").then(
          (value) => JSON.parse(value) as InitDraft,
          () => null,
        ),
        catch: (cause) =>
          new RunboxError({ operation: "resume runbox init", message: String(cause) }),
      })
      if (draft === null) {
        const setup = yield* Prompt.text({
          message: "What does this project need for general setup?",
          default: "Read README and AGENTS.md, then install dependencies with the detected package manager.",
        })
        scripts = yield* Prompt.multiSelect({
          message: "Which commands should runbox bootstrap and verify?",
          choices: Object.keys(info.scripts).sort().map((script) => ({ title: script, value: script })),
          min: 0,
        })
        draft = { setup: setup.trim(), scripts, instructions: {} }
        yield* Effect.promise(() => writeAtomic(draftPath, `${JSON.stringify(draft, null, 2)}\n`))
      } else {
        scripts = [...draft.scripts]
        yield* Console.log("Resuming the existing runbox initialization wizard.")
      }
      for (const script of scripts) {
        if (draft.instructions[script] !== undefined) continue
        const instruction = yield* Prompt.text({
          message: `What preparation does '${script}' need before it runs?`,
          default: "Read the project documentation and make sure dependencies are installed.",
        })
        draft = {
          ...draft,
          instructions: { ...draft.instructions, [script]: instruction.trim() },
        }
        yield* Effect.promise(() => writeAtomic(draftPath, `${JSON.stringify(draft, null, 2)}\n`))
      }
      yield* Effect.promise(async () => {
        for (const script of scripts) {
          const path = join(project.repoRoot, ".agents", "runbox", "instructions", project.packagePath, script)
          await writeAtomic(path, `${draft.instructions[script] ?? ""}\n`)
        }
        await writeAtomic(setupPath, `${draft.setup}\n`)
        await rm(draftPath, { force: true })
      })
      const finish = yield* Prompt.select({
        message: "Finish runbox initialization",
        choices: [
          { title: "Commit now and run setup", value: "bootstrap" as const },
          { title: "I will commit and run init later", value: "later" as const },
        ],
      })
      shouldBootstrap = finish === "bootstrap"
      if (!shouldBootstrap) {
        yield* Console.log("Runbox instructions created. Commit them, then run 'runbox init' again.")
        return
      }
    } else {
      yield* Console.log("Existing runbox instructions found; continuing initialization.")
    }

    if (shouldBootstrap) {
      if (yield* ensureCommitted(project, {
        noTui: false,
        agentCommit: false,
        commitMessage: Option.none(),
      })) project = yield* projects.discover(process.cwd())
      const { socket, state } = yield* initializeClient(
        project,
        Option.isSome(environmentSource) ? environmentSource.value : undefined,
      )
      const source = sourceRef(project)
      if (state.source !== null && !sameSource(state.source, source)) {
        yield* withPreparationProgress(
          daemonRequest(socket, { type: "switch", source }),
          false,
          "Switching initialized source",
        )
      }
      yield* withPreparationProgress(daemonRequest(socket, {
        type: "setup",
        packagePath: project.packagePath,
        source,
      }), false, "Running initial setup")
      for (const script of scripts) {
        yield* daemonRequest(socket, {
          type: "start",
          packagePath: project.packagePath,
          script,
          args: [],
          source,
        })
        yield* waitForCommand(socket, project.packagePath, commandId(project.packagePath, script))
        yield* daemonRequest(socket, {
          type: "stop",
          packagePath: project.packagePath,
          script,
        })
      }
      yield* Console.log(`Runbox initialized; verified ${scripts.length} command${scripts.length === 1 ? "" : "s"}.`)
    }
  })),
).pipe(Command.withDescription("Bootstrap project setup and command instructions"))

const app = root.pipe(
  Command.withSubcommands([
    initCommand,
    runCommand,
    syncCommand,
    forwardCommand,
    stackCommand,
    commandsCommand,
    projectsCommand,
    logsCommand,
    restartCommand,
    doctorCommand,
    stopCommand,
    statusCommand,
    switchCommand,
  ]),
)

const cli = Command.run(app, { name: "runbox", version: "0.2.0" })

const AppLayer = Layer.merge(CoreLayer, BunContext.layer)

safe(cli(process.argv), process.argv.includes("--json")).pipe(Effect.provide(AppLayer), BunRuntime.runMain)
