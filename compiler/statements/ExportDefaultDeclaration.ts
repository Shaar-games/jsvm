// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { OpCode, emit } = require("../utils");
const { addStaticValue } = require("../context");

async function compileExportDefaultDeclaration(node, context) {
  if (node.declaration.type === "FunctionDeclaration") {
    await compileStatement(node.declaration, context);
    const exportRegister = await compileExpression({ type: "Identifier", name: node.declaration.id.name }, context);
    emit(context, [OpCode.EXPORT, addStaticValue(context, "default"), exportRegister]);
    return;
  }

  const valueRegister = await compileExpression(node.declaration, context);
  const staticIndex = addStaticValue(context, "default");
  emit(context, [OpCode.EXPORT, staticIndex, valueRegister]);
}

module.exports = compileExportDefaultDeclaration;

export {};
