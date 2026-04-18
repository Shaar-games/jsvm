// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { initializePattern } = require("../patterns");
const { emitStoreGlobalBinding, shouldExposeVarToGlobal } = require("../script-bindings");
const {
  compileLiteralValue,
  initializeBinding,
} = require("../utils");

async function compileVariableDeclaration(node, context) {
  for (const declaration of node.declarations) {
    const initialValue = declaration.init
      ? await compileExpression(declaration.init, context)
      : compileLiteralValue(undefined, context);

    if (declaration.id.type === "Identifier") {
      initializeBinding(context, declaration.id.name, initialValue, { declarationKind: node.kind });
      if (node.kind === "var" && shouldExposeVarToGlobal(context)) {
        emitStoreGlobalBinding(context, declaration.id.name, initialValue);
      }
      continue;
    }

    if (declaration.id.type === "ObjectPattern") {
      await initializePattern(declaration.id, context, initialValue, node.kind);
      continue;
    }

    if (declaration.id.type === "ArrayPattern") {
      await initializePattern(declaration.id, context, initialValue, node.kind);
      continue;
    }

    throw new Error(`Unsupported declaration type: ${declaration.id.type}`);
  }
}

module.exports = compileVariableDeclaration;

export {};
