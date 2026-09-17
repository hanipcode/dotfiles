// Ported from dmmulroy/anti-slop c44ef22; see ../UPSTREAM.md.
/** Recognize explicit unknown input types, including unions containing unknown. */
export function containsUnknownType(type) {
  if (type.type === "TSUnknownKeyword")
    return true;
  if (type.type === "TSParenthesizedType")
    return containsUnknownType(type.typeAnnotation);
  return type.type === "TSUnionType" && type.types.some(containsUnknownType);
}
/** Read input annotations through rest, default, and constructor parameter wrappers. */
export function functionParameterTypeAnnotation(parameter) {
  if (parameter.type === "TSParameterProperty") {
    return functionParameterTypeAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? functionParameterTypeAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? functionParameterTypeAnnotation(parameter.left);
  }
  return parameter.typeAnnotation;
}
/** Describe the actual input binding, including destructured parameter patterns. */
export function functionParameterBindingName(parameter, sourceCode) {
  if (parameter.type === "TSParameterProperty") {
    return functionParameterBindingName(parameter.parameter, sourceCode);
  }
  if (parameter.type === "AssignmentPattern") {
    return functionParameterBindingName(parameter.left, sourceCode);
  }
  if (parameter.type === "RestElement") {
    return functionParameterBindingName(parameter.argument, sourceCode);
  }
  if (parameter.type === "Identifier")
    return parameter.name;
  const sourceText = sourceCode.getText(parameter);
  const annotationStart = parameter.typeAnnotation?.start;
  return annotationStart === undefined ? sourceText : sourceText.slice(0, annotationStart - parameter.start).trimEnd();
}
