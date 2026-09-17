// Ported from dmmulroy/anti-slop c44ef22; see ../UPSTREAM.md.
/** Resolve a value binding through lexical scopes rather than identifier spelling alone. */
export function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined)
      return variable;
    scope = scope.upper;
  }
  return null;
}
