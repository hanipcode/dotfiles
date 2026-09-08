---
name: ban-unknown-with-lint
description: Configure Oxlint to ban TypeScript unknown except in explicitly reviewed boundary files, tooling, and test files. Use when adding or reviewing unknown-type lint policy.
---

# Ban Unknown With Lint

Treat `unknown` as boundary material: external data may arrive as `unknown`, but
application and domain code receive parsed owner types. Enforce that ownership
with a default ban and an explicit allowlist.

## Configure The Default Ban

Confirm that the project uses Oxlint with the TypeScript plugin, then enable the
shared output rule and restrict explicit `unknown`:

```json
{
  "rules": {
    "byfungsi/no-unknown-output": "error",
    "typescript/no-restricted-types": [
      "error",
      {
        "types": {
          "unknown": "Unknown is allowed only in reviewed boundary, tooling, and test files. Parse boundary input immediately.",
          "Record<string, unknown>": "Decode the input into a schema-derived JSON or domain type."
        }
      }
    ]
  }
}
```

Merge these entries into the existing rule configuration. Preserve every
project-owned restriction already present in `typescript/no-restricted-types`.

## Allow Only Owned Exceptions

Add one override containing:

- exact paths for reviewed runtime boundary files;
- `tools/**/*.{ts,tsx,mts,cts}` for development tooling;
- `**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`, `**/test/**/*.{ts,tsx}`, and
  `**/tests/**/*.{ts,tsx}` for tests.

Disable both restrictions in that override:

```json
{
  "overrides": [
    {
      "files": [
        "packages/http/src/request-boundary.ts",
        "tools/**/*.{ts,tsx,mts,cts}",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/test/**/*.{ts,tsx}",
        "**/tests/**/*.{ts,tsx}"
      ],
      "rules": {
        "byfungsi/no-unknown-output": "off",
        "typescript/no-restricted-types": "off"
      }
    }
  ]
}
```

List runtime boundaries file by file. A directory named `adapter`, `api`, or
`boundary` is not evidence that every file inside it owns unparsed input.
Tooling and test globs are category exceptions because they do not define the
shipped application or domain contract.

If an allowed boundary also needs existing restricted-type policy, replace the
override's `typescript/no-restricted-types: "off"` with the project rules minus
only the `unknown` entries.

## Review Boundary Use

For every allowed production occurrence, verify that:

1. The value originates outside the trusted application or domain model.
2. A schema, decoder, or structural parser consumes it in the same file.
3. The file exposes a parsed owner type rather than `unknown`.
4. No `unknown`, `Record<string, unknown>`, assertion, or generic wrapper carries
   the value into inner code.

`cause: unknown` is not automatically exempt. Keep it only where the file owns
the external failure boundary and translates it before returning.

## Verify

Run the project's existing lint command. Add one temporary violation in an
ordinary source file and one representative use in each allowed category.
Confirm that source fails while the exact boundary, tooling, and test paths
pass, then remove the temporary code.

The policy is complete when ordinary source cannot name `unknown`, every
production exception is an exact reviewed file, and each boundary parses before
returning or storing the value.
