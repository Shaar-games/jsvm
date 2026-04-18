// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { OpCode, emit } = require("../utils");
const { addStaticValue } = require("../context");

async function compileExportNamedDeclaration(node, context) {
  if (node.declaration) {
    await compileStatement(node.declaration, context);

    if (node.declaration.type === "VariableDeclaration") {
      for (const declaration of node.declaration.declarations) {
        if (declaration.id.type !== "Identifier") {
          continue;
        }
        const valueRegister = await compileExpression({ type: "Identifier", name: declaration.id.name }, context);
        emit(context, [OpCode.EXPORT, addStaticValue(context, declaration.id.name), valueRegister]);
      }
      return;
    }

    if (node.declaration.type === "FunctionDeclaration" || node.declaration.type === "ClassDeclaration") {
      const exportName = node.declaration.id.name;
      const valueRegister = await compileExpression({ type: "Identifier", name: exportName }, context);
      emit(context, [OpCode.EXPORT, addStaticValue(context, exportName), valueRegister]);
      return;
    }
  }

  for (const specifier of node.specifiers || []) {
    const localName = specifier.local.name;
    const exportedName = specifier.exported.name;
    const valueRegister = await compileExpression({ type: "Identifier", name: localName }, context);
    emit(context, [OpCode.EXPORT, addStaticValue(context, exportedName), valueRegister]);
  }
}

module.exports = compileExportNamedDeclaration;

export {};
