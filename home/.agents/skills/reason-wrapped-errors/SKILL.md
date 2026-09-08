---
name: reason-wrapped-errors
description: Model Effect errors with stable parent categories and machine-actionable reason variants.
disable-model-invocation: true
metadata:
  opencode/autoinvoke: false
---

# Reason-Wrapped Errors

Use a reason-wrapped error when a boundary needs one stable error category but
callers still need typed, machine-actionable failure variants. Keep unrelated
failures as separate top-level errors.

## Model

1. Define each actionable reason as a `Schema.TaggedError` with only the data
   needed to understand or recover from that variant.
2. Define the reason set as `Schema.Union([...])` and export its schema and
   inferred type.
3. Define the stable parent as a `Schema.TaggedError` with a field named
   `reason` using that union.

```ts
import { Schema } from "effect"

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfterSeconds: Schema.Number }
) {}

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  { limit: Schema.Number }
) {}

export const RequestFailureReason = Schema.Union([
  RateLimited,
  QuotaExceeded
])
export type RequestFailureReason = typeof RequestFailureReason.Type

export class RequestFailure extends Schema.TaggedError<RequestFailure>()(
  "RequestFailure",
  { reason: RequestFailureReason }
) {}
```

Use a reason union only when every member answers the same parent question,
such as why validation failed. A reason that changes the operation's broad
meaning, ownership, or recovery boundary belongs in the top-level error union.

## Preserve Reasons

When translating the parent at an application or transport boundary, retain the
specific reason value rather than flattening it to a message or replacing it
with a generic error.

```ts
domainOperation.pipe(
  Effect.mapError((error) =>
    ApplicationFailure.make({ operation: "request.run", reason: error.reason })
  )
)
```

The destination parent's `reason` schema must accept the preserved union. Add
boundary context beside `reason`; do not duplicate variant-specific data on the
parent.

## Handle Reasons

Choose the narrowest native combinator that matches the caller:

- `Effect.catchReason(parentTag, reasonTag, handler)` handles one reason while
  retaining the parent abstraction.
- `Effect.catchReasons(parentTag, handlers)` handles several reason variants.
- `Effect.unwrapReason(parentTag)` promotes the reasons into the error channel
  so ordinary tagged-error combinators can handle them.

```ts
program.pipe(
  Effect.catchReason("RequestFailure", "RateLimited", (reason) =>
    retryAfter(reason.retryAfterSeconds)
  )
)

program.pipe(
  Effect.unwrapReason("RequestFailure"),
  Effect.catchTags({
    RateLimited: (reason) => retryAfter(reason.retryAfterSeconds),
    QuotaExceeded: (reason) => reportLimit(reason.limit)
  })
)
```

## Verification

- Test each producer through its public function and assert the exact nested
  reason tag and payload.
- Test translations to prove `error.reason` survives unchanged.
- Type-check representative `catchReason`, `catchReasons`, or `unwrapReason`
  consumers so the public recovery contract remains usable.
- Verify the exact API against the project's pinned Effect v4 source before
  changing the pattern.

The work is complete when every actionable variant is schema-backed, the
parent boundary remains stable, translations preserve reasons, and tests prove
both production and consumer handling.
