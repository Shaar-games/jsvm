// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { withAnnexBBlockFunctionContext } = require("../annex-b");
const { OpCode, emit, emitLabel, makeLabel } = require("../utils");

async function compileWhileStatement(node, context) {
  const startLabel = makeLabel(context);
  const endLabel = makeLabel(context);
  context.loopLabels.push({ start: startLabel, end: endLabel });

  emitLabel(context, startLabel);
  const testRegister = await compileExpression(node.test, context);
  emit(context, [OpCode.JUMPF, testRegister, endLabel]);
  await withAnnexBBlockFunctionContext(context, () => compileStatement(node.body, context));
  emit(context, [OpCode.JUMP, startLabel]);
  emitLabel(context, endLabel);

  context.loopLabels.pop();
}

module.exports = compileWhileStatement;

export {};
