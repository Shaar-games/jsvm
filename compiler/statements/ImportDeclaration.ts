// @ts-nocheck
const { OpCode, compileLiteralValue, emit, initializeBinding, newRegister } = require("../utils");

async function compileImportDeclaration(node, context) {
  const sourceRegister = compileLiteralValue(node.source.value, context);
  const namespaceRegister = newRegister(context);
  emit(context, [OpCode.IMPORT, namespaceRegister, sourceRegister, "namespace"]);

  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier") {
      initializeBinding(context, specifier.local.name, namespaceRegister, { declarationKind: "const" });
      continue;
    }

    if (specifier.type === "ImportDefaultSpecifier") {
      const defaultKey = compileLiteralValue("default", context);
      const valueRegister = newRegister(context);
      emit(context, [OpCode.GETFIELD, valueRegister, namespaceRegister, defaultKey]);
      initializeBinding(context, specifier.local.name, valueRegister, { declarationKind: "const" });
      continue;
    }

    if (specifier.type === "ImportSpecifier") {
      const importedName = specifier.imported.type === "Identifier"
        ? specifier.imported.name
        : specifier.imported.value;
      const importedKey = compileLiteralValue(importedName, context);
      const valueRegister = newRegister(context);
      emit(context, [OpCode.GETFIELD, valueRegister, namespaceRegister, importedKey]);
      initializeBinding(context, specifier.local.name, valueRegister, { declarationKind: "const" });
      continue;
    }

    throw new Error(`Unsupported import specifier: ${specifier.type}`);
  }
}

module.exports = compileImportDeclaration;

export {};
