// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit } = require("../utils");

async function compileReturnStatement(node, context) {
  const valueRegister = node.argument
    ? await compileExpression(node.argument, context)
    : "null";
  emit(context, [OpCode.RETURN, valueRegister]);
}

module.exports = compileReturnStatement;

export {};
