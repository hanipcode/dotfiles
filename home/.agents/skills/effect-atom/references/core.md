# Atom Core

## Model

An `Atom<A>` is a registry-managed reactive computation. Its value may be a
plain synchronous value, an `AsyncResult`, a stream-derived value, or a value
derived from other atoms. The registry owns subscription, memoization,
refresh, and disposal.

Use the narrowest constructor that expresses the ownership:

- `Atom.make(value)` for writable local state.
- `Atom.make(() => value)` or `Atom.readable(...)` for synchronous derived
  state.
- `Atom.make(effect)` for an Effect-backed `AsyncResult`.
- `Atom.fn(...)` for an asynchronous writable operation that receives an
  argument.
- `Atom.context()` and `AtomRuntime` when a group of atoms shares a Layer-built
  runtime and stable services.

Verify constructor overloads against the pinned V4 source. The `Atom` module is
unstable API surface, so remembered V3 signatures are not evidence.

## Identity

Atom identity determines whether subscriptions, cached values, transitions,
and cleanup are shared. A parameterized atom factory should normally use
`Atom.family`:

```ts
import * as Atom from "effect/unstable/reactivity/Atom"

export const userAtom = Atom.family((userId: UserId) =>
  Atom.make(loadUser(userId))
)
```

Do not construct a fresh parameterized atom during every React render or every
read of a parent atom. Use immutable, stable key values and keep the family
factory free of unrelated side effects.

When the parameter is a structural object, confirm the pinned `Atom.family`
key semantics before relying on object equality. Prefer a stable primitive or a
canonical immutable key when identity is important.

## AsyncResult

Effect-backed atoms expose `AsyncResult<A, E>` with distinct `Initial`,
`Success`, and `Failure` states. A result can also be `waiting` while retaining
the previous value during refresh.

Use `AsyncResult.match`, `isInitial`, `isSuccess`, `isFailure`, `value`, and
`map` rather than reading fields by convention or throwing with `getOrThrow` in
domain code. Preserve the error cause and previous successful value when
deriving state.

```ts
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

const visibleNames = AsyncResult.map(users, (rows) =>
  rows.map((row) => row.name)
)
```

Do not turn `Initial`, `Failure`, or interruption into an empty successful
value merely to simplify rendering. A UI may deliberately choose a fallback,
but that is an explicit presentation decision at the UI boundary.

## Runtime, registry, and lifetime

An atom registry is the owner of subscriptions and atom state. An Effect-backed
atom that acquires resources must run inside a scope owned by the registry or
the runtime that created it. Long-lived effects need an explicit cancellation
and finalization path.

Use `AtomRuntime` when multiple atoms need the same stable Layer-provided
services. Build that Layer once at the composition boundary and keep request-
specific values as atom inputs. Do not hide application policy or mutable
global state inside a runtime merely to avoid passing a value.

If a test needs a fresh stateful runtime, create a fresh registry or runtime
for that test. Do not share mutable test state across tests without an explicit
suite-level lifetime and isolation argument.

## Reactivity

Reactivity keys identify data invalidation, not UI events. Define a canonical
key vocabulary in the owner of the resource and include every query whose
server value is affected by a mutation.

Use the actual API shape of the client:

- `AtomRuntime.fn` can receive `reactivityKeys` in its options.
- A higher-level mutation client may require keys in the mutation payload or
  at the call site.
- `Atom.withReactivity` can bind a key set to an atom when that is the owning
  abstraction.

Do not invent ad hoc keys at distant call sites, invalidate unrelated data,
or treat optimistic rendering as a substitute for authoritative refresh.

## Testing

Test core Atom behavior through an `AtomRegistry` or runtime interface rather
than inspecting private transition sets or implementation fields. Cover:

- stable family identity for equal keys;
- initial, success, waiting, and failure rendering/state;
- refresh and invalidation of affected queries;
- interruption and cleanup of long-lived effects;
- concurrent writes when the atom is writable or optimistic.

Use `@effect/vitest` and `TestClock` for Effect time. Do not use module mocks
to replace the registry or Effect runtime when a faithful in-memory Layer or
test registry can exercise the public behavior.
