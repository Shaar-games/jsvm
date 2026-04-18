// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { OpCode, emit, emitLabel, makeLabel } = require("../utils");

async function compileForStatement(node, context) {
  const startLabel = makeLabel(context);
  const endLabel = makeLabel(context);
  context.loopLabels.push({ start: startLabel, end: endLabel });

  if (node.init) {
    if (node.init.type.endsWith("Declaration")) {
      await compileStatement(node.init, context);
    } else {
      await compileExpression(node.init, context);
    }
  }

  emitLabel(context, startLabel);
  if (node.test) {
    const testRegister = await compileExpression(node.test, context);
    emit(context, [OpCode.JUMPF, testRegister, endLabel]);
  }

  await compileStatement(node.body, context);

  if (node.update) {
    await compileExpression(node.update, context);
  }

  emit(context, [OpCode.JUMP, startLabel]);
  emitLabel(context, endLabel);

  context.loopLabels.pop();
}

module.exports = compileForStatement;

export {};
