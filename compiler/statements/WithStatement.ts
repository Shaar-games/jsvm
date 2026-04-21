// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { OpCode, emit } = require("../utils");

async function compileWithStatement(node, context) {
  const objectRegister = await compileExpression(node.object, context);
  emit(context, [OpCode.PUSH_WITH, objectRegister]);
  context.withDepth += 1;
  try {
    await compileStatement(node.body, context);
  } finally {
    context.withDepth -= 1;
    emit(context, [OpCode.POP_WITH]);
  }
}

module.exports = compileWithStatement;

export {};
