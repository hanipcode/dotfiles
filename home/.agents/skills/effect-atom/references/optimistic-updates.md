# Optimistic Updates

## When to use

Use optimistic state when a mutation changes a query-backed value and the UI
should show the expected result before the server round trip completes.

If eventual consistency is acceptable, use the mutation and its reactivity
keys without optimistic state. Optimistic reducers are application behavior:
they must represent the expected change precisely and remain safe when calls
race.

## Canonical shape

Wrap the query once and derive mutation writers from that same optimistic atom:

```ts
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"

export const policiesOptimisticAtom = Atom.family((owner: Owner) =>
  Atom.optimistic(policiesAtom(owner))
)

export const updatePolicyOptimistic = Atom.family((owner: Owner) =>
  policiesOptimisticAtom(owner).pipe(
    Atom.optimisticFn({
      reducer: (current, update: UpdatePolicy) =>
        AsyncResult.map(current, (rows) =>
          rows.map((row) =>
            row.id === update.policyId
              ? { ...row, action: update.action }
              : row
          )
        ),
      fn: updatePolicy
    })
  )
)
```

The exact argument and return types belong to the owning mutation client. Keep
the reducer argument compatible with the value passed to `fn`; do not create a
second ad hoc payload shape unless a wrapper owns the translation.

Reads and writes must use the same optimistic family. Reading the plain query
while writing through an optimistic mutation creates visual jumps because the
read does not see the in-flight transitions.

## Race safety

`Atom.optimisticFn` supplies the current optimistic value for each transition.
The reducer must derive its next value from `current`, not from a captured
React value, a captured query snapshot, or a previously read server result.

```ts
reducer: (current, update) =>
  AsyncResult.map(current, (rows) => applyUpdate(rows, update))
```

Do not build a parallel `pending` Map, Set, or array with React state or a
custom atom. Do not clear placeholders in `finally`. Those approaches allow an
earlier response to erase a later transition.

When a create operation needs a temporary identity, generate the identity and
any timestamp at the operation boundary and pass them as explicit mutation
input. The reducer remains deterministic for a given `current` and input:

```ts
type CreatePolicy = {
  readonly policyId: PolicyId
  readonly createdAt: number
  readonly pattern: string
  readonly action: PolicyAction
}

const createPolicyOptimistic = policiesOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (current, input: CreatePolicy) =>
      AsyncResult.map(current, (rows) => [
        {
          id: input.policyId,
          createdAt: input.createdAt,
          pattern: input.pattern,
          action: input.action
        },
        ...rows
      ]),
    fn: createPolicy
  })
)
```

Whether a temporary row survives a failed mutation, how a server-minted ID is
reconciled, and which query keys refresh are caller-visible policies. Test
those outcomes through the public atom interface.

## Failure and refresh

An unsuccessful transition must not become a successful fallback value. Let the
optimistic layer roll back or refresh the source atom according to its V4
semantics, then expose the typed failure to the boundary that owns recovery.

Reactivity keys still matter. Optimistic state paints a local provisional value;
the authoritative query refresh reconciles server-side effects, validation,
normalization, and mutations that affect related resources.

## What is not optimistic server data

Do not use this pattern for ordinary:

- form input and dirty fields;
- modal, hover, or menu state;
- submit/busy booleans;
- toast and error-message visibility;
- local drafts that are not derived from a server query.

Those states belong to the UI or feature owner unless they are intentionally
shared reactive data with a separate ownership model.

## Tests

At minimum, test the observable behavior for the changed mutation:

- the optimistic value appears before the mutation settles;
- a failure does not become a success and the source value is restored or
  refreshed according to policy;
- two rapid transitions compose from `current` without an earlier completion
  deleting a later optimistic value;
- a successful mutation triggers the required authoritative refresh;
- reads use the same optimistic atom as writes.

Use a real registry/runtime and a deterministic in-memory mutation effect. Use
explicit synchronization rather than sleeps for race tests.
