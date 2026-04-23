// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { withAnnexBBlockFunctionContext } = require("../annex-b");
const { OpCode, emit, emitLabel, makeLabel, popControlLabel, pushControlLabel } = require("../utils");

async function compileWhileStatement(node, context) {
  const startLabel = makeLabel(context);
  const endLabel = makeLabel(context);
  const loopLabelName = context.pendingLoopLabel || null;
  context.pendingLoopLabel = null;
  pushControlLabel(context, { label: loopLabelName, continueLabel: startLabel, breakLabel: endLabel });

  emitLabel(context, startLabel);
  const testRegister = await compileExpression(node.test, context);
  emit(context, [OpCode.JUMPF, testRegister, endLabel]);
  await withAnnexBBlockFunctionContext(context, () => compileStatement(node.body, context));
  emit(context, [OpCode.JUMP, startLabel]);
  emitLabel(context, endLabel);

  popControlLabel(context);
}

module.exports = compileWhileStatement;

export {};
