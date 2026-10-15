function siblingStatements(returnStatement) {
  const parent = returnStatement.parent;
  if (parent.type === "BlockStatement") return parent.body;
  if (parent.type === "SwitchCase") return parent.consequent;
  return null;
}

function hasBlankLine(text) {
  return /\r?\n[\t ]*\r?\n/u.test(text);
}

function blankLineFix(fixer, sourceCode, previousStatement, returnStatement) {
  const textBetween = sourceCode.text.slice(previousStatement.end, returnStatement.start);
  const lineBreak = /\r?\n/u.exec(textBetween);

  if (lineBreak !== null) {
    const insertionPoint = previousStatement.end + lineBreak.index + lineBreak[0].length;
    return fixer.insertTextAfterRange([insertionPoint, insertionPoint], lineBreak[0]);
  }

  const currentLineStart = sourceCode.text.lastIndexOf("\n", returnStatement.start - 1) + 1;
  const currentLinePrefix = sourceCode.text.slice(currentLineStart, returnStatement.start);
  const indentation = /^[\t ]*/u.exec(currentLinePrefix)?.[0] ?? "";
  const insertedLineBreak = sourceCode.text.includes("\r\n") ? "\r\n" : "\n";
  return fixer.replaceTextRange(
    [previousStatement.end, returnStatement.start],
    `${insertedLineBreak}${insertedLineBreak}${indentation}`
  );
}

/** Require a blank line before a block-level return that follows another statement. */
export const requireBlankLineBeforeReturnRule = {
  meta: {
    type: "layout",
    docs: {
      description: "Require visual separation before a block-level return statement."
    },
    fixable: "whitespace",
    messages: {
      missingBlankLine: "Add a blank line before this return statement."
    }
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      ReturnStatement(node) {
        const statements = siblingStatements(node);
        if (statements === null) return;

        const statementIndex = statements.indexOf(node);
        if (statementIndex < 1) return;

        const previousStatement = statements[statementIndex - 1];
        const textBetween = sourceCode.text.slice(previousStatement.end, node.start);
        if (hasBlankLine(textBetween)) return;

        context.report({
          node,
          messageId: "missingBlankLine",
          fix(fixer) {
            return blankLineFix(fixer, sourceCode, previousStatement, node);
          }
        });
      }
    };
  }
};
