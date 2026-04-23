// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { withAnnexBBlockFunctionContext } = require("../annex-b");
const { OpCode, emit, emitLabel, makeLabel, popControlLabel, pushControlLabel } = require("../utils");

async function compileDoWhileStatement(node, context) {
  const startLabel = makeLabel(context, "DO_WHILE_START");
  const continueLabel = makeLabel(context, "DO_WHILE_CONTINUE");
  const endLabel = makeLabel(context, "DO_WHILE_END");
  const loopLabelName = context.pendingLoopLabel || null;
  context.pendingLoopLabel = null;
  pushControlLabel(context, { label: loopLabelName, continueLabel, breakLabel: endLabel });

  emitLabel(context, startLabel);
  await withAnnexBBlockFunctionContext(context, () => compileStatement(node.body, context));
  emitLabel(context, continueLabel);
  const testRegister = await compileExpression(node.test, context);
  emit(context, [OpCode.JUMPT, testRegister, startLabel]);
  emitLabel(context, endLabel);

  popControlLabel(context);
}

module.exports = compileDoWhileStatement;

export {};
