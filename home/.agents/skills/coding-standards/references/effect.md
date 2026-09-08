# Effect

These defaults require Effect v4 for new Effect work.

## Version policy

Use Effect v4 rather than v3 for new code, new examples, and changed Effect
paths. Do not introduce a v3 API, mix v3 and v4 APIs, or expand an existing v3
implementation without an explicit migration decision.

When a project or package is pinned to Effect v3, stop before changing its
Effect code and ask whether to migrate that project or package to v4. A small
bug fix is not permission to perform a partial migration. Preserve untouched
legacy code until the migration boundary is agreed.

## Source rule

Inspect the project's pinned `effect` package version and source before selecting APIs. Prefer vendored or pinned examples over remembered APIs. Consult the configured `@effect` OpenCode reference (`Effect-TS/effect`) when the pinned package does not answer the question.

Before designing an Effect pattern, query the installed Effect Solutions field
manual for the relevant topic:

```sh
effect-solutions list
effect-solutions show <relevant-topics>
```

Effect Solutions is prescriptive guidance, not API authority. Verify every
example against the pinned v4 source and this repository's standards. If the
CLI is unavailable, report the setup gap rather than silently treating
remembered v3 examples as valid.

## Branch chooser

Read every branch that matches the changed behavior:

- Data models, schemas, brands, variants, optional keys, or decoders: [`effect-schema-and-data.md`](effect-schema-and-data.md).
- Services, module surfaces, Layers, runtime wiring, `Effect.fn`, or test services: [`effect-services.md`](effect-services.md).
- Alchemy Workers, Durable Objects, Workflows, binding-backed services, or two-phase Effectful Constructors: [`effect-alchemy.md`](effect-alchemy.md).
- Runtime config, environment variables, `ConfigProvider`, or `layerConfig`: [`effect-configuration.md`](effect-configuration.md).
- Retry, repeat, polling, backoff, jitter, rate limits, timeouts, or pass loops: [`effect-scheduling-and-retry.md`](effect-scheduling-and-retry.md).
- Memoization, TTL caches, concurrent lookup deduplication, or request batching: [`effect-caching.md`](effect-caching.md).
- Streams, event sources, async iterables, queues, pubsubs, pagination, backpressure, or stream consumers: [`effect-streams.md`](effect-streams.md).
- Outgoing HTTP, Effect `HttpClient`, status handling, or HTTP rate limiting: [`effect-http-clients.md`](effect-http-clients.md).
- Effect tests, time, sleeps, concurrency synchronization, fakes, or test Layers: [`effect-testing.md`](effect-testing.md).
- Atom, `AsyncResult`, `Reactivity`, optimistic state, atom identity, or `@effect/atom-react`: load the standalone [`effect-atom`](../../effect-atom/SKILL.md) skill and every matching reference branch.

## Cross-cutting defaults

- Compose workflows with `Effect.gen(function* () { ... })` and the project's established `Effect.fn` patterns.
- Recover from the typed error channel at the narrowest boundary with a truthful response; preserve defects and interruption.
- Use native Effect workflows. Isolate unavoidable Promise or platform APIs in their owning Adapter.

## Completion check

Every matching branch has been read, every chosen Effect API has been verified in the pinned package source, and every cross-cutting default has been checked against each changed Effect path. Report any exception with concrete evidence.
