import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../byfungsi/index.mjs";

const rule = plugin.rules["require-blank-line-before-return"];
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingBlankLine" };

tester.run("byfungsi/require-blank-line-before-return", rule, {
  valid: [
    "function read() { return value; }",
    "function read() {\n  return value;\n}",
    "function read() {\n  const value = load();\n\n  return value;\n}",
    "function read(value: string | null) {\n  if (value === null) return null;\n\n  return value;\n}",
    "function read(value: string | null) {\n  if (value === null) {\n    return null;\n  }\n\n  return value;\n}"
  ],
  invalid: [
    {
      code: "function read() {\n  const value = load();\n  return value;\n}",
      output: "function read() {\n  const value = load();\n\n  return value;\n}",
      errors: [error]
    },
    {
      code: "function read() {\n  run(); // trailing comment\n  // Explain the result.\n  return value;\n}",
      output: "function read() {\n  run(); // trailing comment\n\n  // Explain the result.\n  return value;\n}",
      errors: [error]
    },
    {
      code: "function read() { run(); return value; }",
      output: "function read() { run();\n\nreturn value; }",
      errors: [error]
    },
    {
      code: "function read(value: string | null) {\n  if (value === null) {\n    log();\n    return null;\n  }\n\n  return value;\n}",
      output: "function read(value: string | null) {\n  if (value === null) {\n    log();\n\n    return null;\n  }\n\n  return value;\n}",
      errors: [error]
    }
  ]
});
