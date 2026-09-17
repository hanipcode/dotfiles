import { RuleTester } from "oxlint/plugins-dev"
import plugin from "../byfungsi/index.mjs"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })

tester.run("byfungsi/no-unknown-output", plugin.rules["no-unknown-output"], {
  valid: [
    "function parse(input: unknown): string { return String(input); }",
    "type User = { id: string }; function read(): User { return { id: 'a' }; }",
    "const internal: unknown = readExternal();",
    "export const parsed: { id: string } = { id: 'a' };",
  ],
  invalid: [
    "function read(): unknown {}",
    "function read(): Promise<unknown> {}",
    "function read(): { value: unknown } {}",
    "interface Output { value: unknown }",
    "class Output { value: unknown }",
    "export const output: unknown = external();",
    "const output: unknown = external(); export { output };",
    "type Output = unknown; function read(): Output {}",
  ].map((code) => ({ code, errors: 1 })),
})

tester.run("byfungsi/no-widen-then-assert", plugin.rules["no-widen-then-assert"], {
  valid: [
    "const data: unknown = external(); const result = data as User;",
    "const data = { id: 'a' }; const result = data as User;",
    "let data: unknown = { id: 'a' }; data = external(); const result = data as User;",
  ],
  invalid: [
    "const data: unknown = { id: 'a' }; const result = data as User;",
    "const data: any = { id: 'a' }; const result = data as User;",
    "type Broad = unknown; const data: Broad = { id: 'a' }; const result = data as User;",
    "const source = { id: 'a' }; const data: object = source; const result = data as User;",
  ].map((code) => ({ code, errors: 1 })),
})

tester.run("byfungsi/known-value-local-policy", plugin.rules["no-known-value-widening"], {
  valid: [
    "function read(): { id: string } { return { id: 'a' }; }",
    "const data: Record<'id', string> = { id: 'a' };",
    "const data = { id: 'a' } satisfies Record<string, string>;",
    "type Bag<T> = Record<string, T>; const data: Bag<string> = {};",
  ],
  invalid: [
    "const data: any = { id: 'a' };",
    "const data: {} = { id: 'a' };",
    "type Empty = {}; const data: Empty = { id: 'a' };",
    "type Broad = any; const data: Broad = { id: 'a' };",
    "type Identity<T> = T; const data: Identity<unknown> = { id: 'a' };",
    "type Identity<T> = T; const data: Identity<any> = { id: 'a' };",
    "type Identity<T> = T; const data: Identity<object> = { id: 'a' };",
    "type Identity<T> = T; const data: Identity<{}> = { id: 'a' };",
  ].map((code) => ({ code, errors: [{ messageId: "widening" }] })),
})
