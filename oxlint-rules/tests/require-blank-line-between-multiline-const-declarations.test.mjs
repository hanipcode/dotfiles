import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../byfungsi/index.mjs";

const rule = plugin.rules["require-blank-line-between-multiline-const-declarations"];
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "missingBlankLine" };

tester.run("byfungsi/require-blank-line-between-multiline-const-declarations", rule, {
  valid: [
    "const first = 1;\nconst second = 2;",
    "const first = {\n  value: 1\n};\n\nconst second = 2;",
    "const first = {\n  value: 1\n};\nrun();\nconst second = {\n  value: 2\n};",
    "let first = {\n  value: 1\n};\nconst second = 2;",
    "const first = {\n  value: 1\n};\nlet second = 2;",
    "export const first = {\n  value: 1\n};\n\nexport const second = 2;"
  ],
  invalid: [
    {
      code: "const first = {\n  value: 1\n};\nconst second = 2;",
      output: "const first = {\n  value: 1\n};\n\nconst second = 2;",
      errors: [error]
    },
    {
      code: "const first = 1;\nconst second = {\n  value: 2\n};",
      output: "const first = 1;\n\nconst second = {\n  value: 2\n};",
      errors: [error]
    },
    {
      code: "function build() {\n  const first = {\n    value: 1\n  };\n  const second = 2;\n}",
      output: "function build() {\n  const first = {\n    value: 1\n  };\n\n  const second = 2;\n}",
      errors: [error]
    },
    {
      code: "const first = {\n  value: 1\n}; // trailing comment\n// Describes second.\nconst second = 2;",
      output: "const first = {\n  value: 1\n}; // trailing comment\n\n// Describes second.\nconst second = 2;",
      errors: [error]
    },
    {
      code: "export const first = {\n  value: 1\n};\nexport const second = 2;",
      output: "export const first = {\n  value: 1\n};\n\nexport const second = 2;",
      errors: [error]
    },
    {
      code: "const first = 1; const second = {\n  value: 2\n};",
      output: "const first = 1;\nconst second = {\n  value: 2\n};",
      errors: [error]
    }
  ]
});
