function declarationFromStatement(statement) {
  if (statement?.type === "VariableDeclaration") return statement;
  if (
    statement?.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration"
  ) {
    return statement.declaration;
  }
  return null;
}

function enclosingStatement(variableDeclaration) {
  if (
    variableDeclaration.parent.type === "ExportNamedDeclaration" &&
    variableDeclaration.parent.declaration === variableDeclaration
  ) {
    return variableDeclaration.parent;
  }
  return variableDeclaration;
}

function siblingStatements(statement) {
  const parent = statement.parent;
  if (
    parent.type === "Program" ||
    parent.type === "BlockStatement" ||
    parent.type === "StaticBlock" ||
    parent.type === "TSModuleBlock"
  ) {
    return parent.body;
  }
  if (parent.type === "SwitchCase") return parent.consequent;
  return null;
}

function isMultiline(node) {
  return node.loc.start.line !== node.loc.end.line;
}

function hasBlankLine(text) {
  return /\r?\n[\t ]*\r?\n/u.test(text);
}

function blankLineFix(fixer, sourceCode, previousStatement, currentStatement) {
  const textBetween = sourceCode.text.slice(previousStatement.end, currentStatement.start);
  const lineBreak = /\r?\n/u.exec(textBetween);

  if (lineBreak !== null) {
    const insertionPoint = previousStatement.end + lineBreak.index + lineBreak[0].length;
    return fixer.insertTextAfterRange([insertionPoint, insertionPoint], lineBreak[0]);
  }

  const currentLineStart = sourceCode.text.lastIndexOf("\n", currentStatement.start - 1) + 1;
  const currentLinePrefix = sourceCode.text.slice(currentLineStart, currentStatement.start);
  const indentation = /^[\t ]*/u.exec(currentLinePrefix)?.[0] ?? "";
  return fixer.replaceTextRange(
    [previousStatement.end, currentStatement.start],
    `\n${indentation}`
  );
}

/** Require a blank line between adjacent const declarations when either declaration is multiline. */
export const requireBlankLineBetweenMultilineConstDeclarationsRule = {
  meta: {
    type: "layout",
    docs: {
      description:
        "Require visual separation between adjacent const declarations when either declaration spans multiple lines."
    },
    fixable: "whitespace",
    messages: {
      missingBlankLine:
        "Add a blank line between adjacent const declarations when either declaration is multiline."
    }
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      VariableDeclaration(node) {
        if (node.kind !== "const") return;

        const statement = enclosingStatement(node);
        const statements = siblingStatements(statement);
        if (statements === null) return;

        const statementIndex = statements.indexOf(statement);
        if (statementIndex < 1) return;

        const previousStatement = statements[statementIndex - 1];
        const previousDeclaration = declarationFromStatement(previousStatement);
        if (previousDeclaration?.kind !== "const") return;
        if (!isMultiline(previousDeclaration) && !isMultiline(node)) return;

        const textBetween = sourceCode.text.slice(previousStatement.end, statement.start);
        if (hasBlankLine(textBetween)) return;

        context.report({
          node,
          messageId: "missingBlankLine",
          fix(fixer) {
            return blankLineFix(fixer, sourceCode, previousStatement, statement);
          }
        });
      }
    };
  }
};
