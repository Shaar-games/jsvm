// @ts-nocheck
function collectPatternBindingNames(patternNode, names = []) {
  if (!patternNode) {
    return names;
  }

  switch (patternNode.type) {
    case "Identifier":
      names.push(patternNode.name);
      return names;
    case "AssignmentPattern":
      return collectPatternBindingNames(patternNode.left, names);
    case "RestElement":
      return collectPatternBindingNames(patternNode.argument, names);
    case "ArrayPattern":
      for (const element of patternNode.elements) {
        collectPatternBindingNames(element, names);
      }
      return names;
    case "ObjectPattern":
      for (const property of patternNode.properties) {
        if (property.type === "RestElement") {
          collectPatternBindingNames(property.argument, names);
          continue;
        }
        collectPatternBindingNames(property.value, names);
      }
      return names;
    default:
      return names;
  }
}

module.exports = {
  collectPatternBindingNames,
};

export {};
