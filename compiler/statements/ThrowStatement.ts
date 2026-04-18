// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit } = require("../utils");

async function compileThrowStatement(node, context) {
  const valueRegister = await compileExpression(node.argument, context);
  emit(context, [OpCode.THROW, valueRegister]);
}

module.exports = compileThrowStatement;

export {};
