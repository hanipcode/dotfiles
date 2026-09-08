const unwrapType = (node) => {
  let current = node
  while (current?.type === "TSParenthesizedType") current = current.typeAnnotation
  return current
}

const typeReferenceName = (node) =>
  node?.type === "TSTypeReference" && node.typeName.type === "Identifier"
    ? node.typeName.name
    : null

const buildTypeAliases = (program) => {
  const aliases = new Map()
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type === "TSTypeAliasDeclaration" && !declaration.typeParameters) {
      aliases.set(declaration.id.name, declaration.typeAnnotation)
    }
  }
  return aliases
}

const resolveAlias = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  const name = typeReferenceName(type)
  if (name === null || type.typeArguments?.params.length || visited.has(name)) return type
  const aliased = aliases.get(name)
  if (aliased === undefined) return type
  const nextVisited = new Set(visited)
  nextVisited.add(name)
  return resolveAlias(aliased, aliases, nextVisited)
}

const isUnsafeValueType = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  if (
    type?.type === "TSUnknownKeyword" ||
    type?.type === "TSAnyKeyword" ||
    type?.type === "TSObjectKeyword" ||
    (type?.type === "TSTypeLiteral" && type.members.length === 0)
  ) {
    return true
  }
  if (type?.type === "TSUnionType") {
    return type.types.some((member) => isUnsafeValueType(member, aliases, visited))
  }
  const name = typeReferenceName(type)
  if (name === null || type.typeArguments?.params.length || visited.has(name)) return false
  const aliased = aliases.get(name)
  if (aliased === undefined) return false
  const nextVisited = new Set(visited)
  nextVisited.add(name)
  return isUnsafeValueType(aliased, aliases, nextVisited)
}

const isBroadKeyType = (node) => {
  const type = unwrapType(node)
  if (["TSStringKeyword", "TSNumberKeyword", "TSSymbolKeyword"].includes(type?.type)) return true
  if (type?.type === "TSUnionType") return type.types.every(isBroadKeyType)
  return typeReferenceName(type) === "PropertyKey"
}

const unsafeDictionaryValue = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  if (type?.type === "TSTypeReference") {
    const name = typeReferenceName(type)
    const parameters = type.typeArguments?.params ?? []
    if (
      (name === "Record" || name === "ReadonlyRecord") &&
      parameters.length === 2 &&
      isBroadKeyType(parameters[0]) &&
      isUnsafeValueType(parameters[1], aliases)
    ) {
      return parameters[1]
    }
    if (name === "Readonly" && parameters.length === 1) {
      return unsafeDictionaryValue(parameters[0], aliases, visited)
    }
    if (name !== null && parameters.length === 0 && !visited.has(name)) {
      const aliased = aliases.get(name)
      if (aliased !== undefined) {
        const nextVisited = new Set(visited)
        nextVisited.add(name)
        return unsafeDictionaryValue(aliased, aliases, nextVisited)
      }
    }
  }
  if (type?.type === "TSTypeLiteral" && type.members.length === 1) {
    const [member] = type.members
    const [parameter] = member?.type === "TSIndexSignature" ? member.parameters : []
    if (
      member?.type === "TSIndexSignature" &&
      member.parameters.length === 1 &&
      parameter?.typeAnnotation &&
      isBroadKeyType(parameter.typeAnnotation.typeAnnotation) &&
      member.typeAnnotation &&
      isUnsafeValueType(member.typeAnnotation.typeAnnotation, aliases)
    ) {
      return member.typeAnnotation.typeAnnotation
    }
  }
  if (type?.type === "TSMappedType" && type.typeAnnotation) {
    if (isUnsafeValueType(type.typeAnnotation, aliases)) return type.typeAnnotation
  }
  return null
}

const broadTypeKind = (node, aliases) => {
  const type = resolveAlias(node, aliases)
  if (type?.type === "TSUnknownKeyword" || type?.type === "TSAnyKeyword") return "top type"
  if (type?.type === "TSObjectKeyword") return "object type"
  if (type?.type === "TSTypeLiteral" && type.members.length === 0) return "empty object type"
  if (unsafeDictionaryValue(type, aliases) !== null) return "unsafe dictionary type"
  if (
    type?.type === "TSTypeReference" &&
    (type.typeArguments?.params ?? []).some((parameter) => isUnsafeValueType(parameter, aliases))
  ) {
    return "broad generic type"
  }
  return null
}

const parameterAnnotation = (parameter) => {
  if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter)
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument)
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation
  }
  return parameter.typeAnnotation
}

const parameterVisitors = (check) => ({
  ArrowFunctionExpression: check,
  FunctionDeclaration: check,
  FunctionExpression: check,
  TSCallSignatureDeclaration: check,
  TSConstructSignatureDeclaration: check,
  TSConstructorType: check,
  TSDeclareFunction: check,
  TSEmptyBodyFunctionExpression: check,
  TSFunctionType: check,
  TSMethodSignature: check,
})

const noObjectParameters = {
  create(context) {
    let aliases = new Map()
    const check = (node) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter)
        if (annotation && resolveAlias(annotation.typeAnnotation, aliases).type === "TSObjectKeyword") {
          context.report({
            node: annotation.typeAnnotation,
            message:
              "Avoid broad object parameters; use an owner-provided type, a precise generic, or decode the value at its boundary.",
          })
        }
      }
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      ...parameterVisitors(check),
    }
  },
}

const noUnsafeDictionaryType = {
  create(context) {
    let aliases = new Map()
    const reported = new Set()
    const check = (node) => {
      const unsafe = unsafeDictionaryValue(node, aliases)
      if (unsafe === null) return
      const key = `${node.start}:${node.end}`
      if (reported.has(key)) return
      reported.add(key)
      context.report({
        node: unsafe,
        message:
          "Avoid dictionaries with unknown, any, object, or empty-object values; use a concrete owner or schema-derived value type.",
      })
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      TSTypeAliasDeclaration(node) {
        check(node.typeAnnotation)
      },
      TSTypeReference: check,
      TSTypeLiteral: check,
      TSMappedType: check,
    }
  },
}

const unwrapExpression = (node) => {
  let current = node
  while (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
    ].includes(current?.type)
  ) {
    current = current.expression
  }
  return current
}

const isKnownEvidenceExpression = (node) =>
  [
    "ArrayExpression",
    "ArrowFunctionExpression",
    "ClassExpression",
    "FunctionExpression",
    "Literal",
    "NewExpression",
    "ObjectExpression",
    "TemplateLiteral",
  ].includes(unwrapExpression(node)?.type)

const resolveVariable = (sourceCode, identifier) => {
  let scope = sourceCode.getScope(identifier)
  while (scope !== null) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) return variable
    scope = scope.upper
  }
  return null
}

const variableDeclarator = (variable) => {
  if (variable?.defs.length !== 1) return null
  const [definition] = variable.defs
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null
}

const hasKnownEvidence = (sourceCode, expression, visited = new Set()) => {
  if (isKnownEvidenceExpression(expression)) return true
  const unwrapped = unwrapExpression(expression)
  if (unwrapped?.type !== "Identifier") return false
  const variable = resolveVariable(sourceCode, unwrapped)
  if (variable === null || visited.has(variable)) return false
  const declarator = variableDeclarator(variable)
  if (
    declarator === null ||
    declarator.init === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return false
  }
  const nextVisited = new Set(visited)
  nextVisited.add(variable)
  return hasKnownEvidence(sourceCode, declarator.init, nextVisited)
}

const functionOwner = (node) => {
  let current = node.parent
  while (current && current.type !== "Program") {
    if (["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(current.type)) {
      return current
    }
    current = current.parent
  }
  return null
}

const noKnownValueWidening = {
  create(context) {
    let aliases = new Map()
    const report = (expression, typeNode, subject) => {
      if (!typeNode || !hasKnownEvidence(context.sourceCode, expression)) return
      const kind = broadTypeKind(typeNode, aliases)
      if (kind === null) return
      context.report({
        node: expression,
        message: `Do not widen the known ${subject} to a ${kind}; preserve inference, use satisfies, or use a named owner contract.`,
      })
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) {
          report(node.init, node.id.typeAnnotation?.typeAnnotation, `value of ${node.id.name}`)
        }
      },
      PropertyDefinition(node) {
        if (node.value) report(node.value, node.typeAnnotation?.typeAnnotation, "property value")
      },
      ReturnStatement(node) {
        if (node.argument) report(node.argument, functionOwner(node)?.returnType?.typeAnnotation, "return value")
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== "BlockStatement") {
          report(node.body, node.returnType?.typeAnnotation, "return value")
        }
      },
      TSAsExpression(node) {
        if (node.parent.type !== "TSAsExpression") {
          report(node.expression, node.typeAnnotation, "asserted value")
        }
      },
      TSTypeAssertion(node) {
        if (node.parent.type !== "TSTypeAssertion") {
          report(node.expression, node.typeAnnotation, "asserted value")
        }
      },
    }
  },
}

const unknownTypeNode = (node, aliases, visited = new Set()) => {
  const type = unwrapType(node)
  if (type?.type === "TSUnknownKeyword") return type
  if (type === null || typeof type !== "object") return null

  const name = typeReferenceName(type)
  if (name !== null && !(type.typeArguments?.params.length) && !visited.has(name)) {
    const aliased = aliases.get(name)
    if (aliased !== undefined) {
      const nextVisited = new Set(visited)
      nextVisited.add(name)
      const unknown = unknownTypeNode(aliased, aliases, nextVisited)
      if (unknown !== null) return unknown
    }
  }

  for (const [key, value] of Object.entries(type)) {
    if (["parent", "loc", "range", "start", "end"].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) {
        const unknown = unknownTypeNode(child, aliases, visited)
        if (unknown !== null) return unknown
      }
    } else {
      const unknown = unknownTypeNode(value, aliases, visited)
      if (unknown !== null) return unknown
    }
  }
  return null
}

const exportedBindingNames = (program) => {
  const names = new Set()
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration?.type === "VariableDeclaration") {
        for (const declaration of statement.declaration.declarations) {
          if (declaration.id.type === "Identifier") names.add(declaration.id.name)
        }
      }
      for (const specifier of statement.specifiers) {
        if (specifier.local?.type === "Identifier") names.add(specifier.local.name)
      }
    } else if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration.type === "Identifier"
    ) {
      names.add(statement.declaration.name)
    }
  }
  return names
}

const noUnknownOutput = {
  create(context) {
    let aliases = new Map()
    let exportedNames = new Set()
    const reported = new Set()
    const report = (typeNode, subject) => {
      if (!typeNode) return
      const unknown = unknownTypeNode(typeNode, aliases)
      if (unknown === null) return
      const key = `${unknown.start}:${unknown.end}`
      if (reported.has(key)) return
      reported.add(key)
      context.report({
        node: unknown,
        message: `Do not expose unknown from ${subject}; expose a parsed owner type and keep unknown at the input boundary.`,
      })
    }
    const checkReturn = (node) => report(node.returnType?.typeAnnotation, "a return type")
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
        exportedNames = exportedBindingNames(node)
      },
      ...parameterVisitors(checkReturn),
      PropertyDefinition(node) {
        report(node.typeAnnotation?.typeAnnotation, "a property")
      },
      TSIndexSignature(node) {
        report(node.typeAnnotation?.typeAnnotation, "an index signature")
      },
      TSPropertySignature(node) {
        report(node.typeAnnotation?.typeAnnotation, "a property contract")
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          exportedNames.has(node.id.name) &&
          (node.parent.parent.type === "Program" || node.parent.parent.type === "ExportNamedDeclaration")
        ) {
          report(node.id.typeAnnotation?.typeAnnotation, `exported binding ${node.id.name}`)
        }
      },
    }
  },
}

const isTypeAssertion = (node) =>
  node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion"

const noChainedTypeAssertions = {
  create(context) {
    const check = (node) => {
      if (isTypeAssertion(node.parent) && node.parent.expression === node) return
      let current = node
      let count = 0
      while (isTypeAssertion(current)) {
        count += 1
        current = current.expression
        while (current?.type === "ParenthesizedExpression") current = current.expression
      }
      if (count > 1) {
        context.report({
          node,
          message:
            "Do not chain type assertions; preserve the original type or parse genuinely external input at its boundary.",
        })
      }
    }
    return { TSAsExpression: check, TSTypeAssertion: check }
  },
}

const noWidenThenAssert = {
  create(context) {
    let aliases = new Map()
    const check = (node) => {
      const expression = unwrapExpression(node.expression)
      if (expression?.type !== "Identifier") return
      const variable = resolveVariable(context.sourceCode, expression)
      const declarator = variableDeclarator(variable)
      if (
        declarator === null ||
        declarator.init === null ||
        declarator.id.type !== "Identifier" ||
        declarator.parent.type !== "VariableDeclaration" ||
        declarator.parent.kind !== "const" ||
        !hasKnownEvidence(context.sourceCode, declarator.init)
      ) {
        return
      }
      const annotation = declarator.id.typeAnnotation?.typeAnnotation
      const initializerAssertion = isTypeAssertion(declarator.init) ? declarator.init.typeAnnotation : null
      if (broadTypeKind(annotation ?? initializerAssertion, aliases) === null) return
      if (broadTypeKind(node.typeAnnotation, aliases) !== null) return
      context.report({
        node,
        message: `Binding ${expression.name} widens known evidence and later asserts it back; preserve its precise type end-to-end.`,
      })
    }
    return {
      Program(node) {
        aliases = buildTypeAliases(node)
      },
      TSAsExpression: check,
      TSTypeAssertion: check,
    }
  },
}

const noConditionalEmptyObjectSpread = {
  create(context) {
    return {
      SpreadElement(node) {
        if (node.parent.type !== "ObjectExpression") return
        const expression = unwrapExpression(node.argument)
        if (expression?.type !== "ConditionalExpression") return
        const isEmptyObject = (branch) => {
          const unwrapped = unwrapExpression(branch)
          return unwrapped?.type === "ObjectExpression" && unwrapped.properties.length === 0
        }
        if (!isEmptyObject(expression.consequent) && !isEmptyObject(expression.alternate)) return
        context.report({
          node,
          message:
            "Avoid conditional empty-object spreads; construct the precise object branch or assign the optional property explicitly.",
        })
      },
    }
  },
}

const noRuntimeTypeof = {
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "typeof") {
          context.report({
            node,
            message:
              "Avoid runtime typeof; use a schema, typed discriminant, or platform-safe access.",
          })
        }
      },
    }
  },
}

export default {
  meta: { name: "byfungsi" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertions,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpread,
    "no-known-value-widening": noKnownValueWidening,
    "no-object-parameters": noObjectParameters,
    "no-runtime-typeof": noRuntimeTypeof,
    "no-unknown-output": noUnknownOutput,
    "no-unsafe-dictionary-type": noUnsafeDictionaryType,
    "no-widen-then-assert": noWidenThenAssert,
  },
}
