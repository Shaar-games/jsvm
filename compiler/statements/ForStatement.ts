// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { withAnnexBBlockFunctionContext } = require("../annex-b");
const { OpCode, emit, emitLabel, makeLabel, popControlLabel, pushControlLabel } = require("../utils");

async function compileForStatement(node, context) {
  const startLabel = makeLabel(context);
  const endLabel = makeLabel(context);
  const loopLabelName = context.pendingLoopLabel || null;
  context.pendingLoopLabel = null;
  pushControlLabel(context, { label: loopLabelName, continueLabel: startLabel, breakLabel: endLabel });

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

  await withAnnexBBlockFunctionContext(context, () => compileStatement(node.body, context));

  if (node.update) {
    await compileExpression(node.update, context);
  }

  emit(context, [OpCode.JUMP, startLabel]);
  emitLabel(context, endLabel);

  popControlLabel(context);
}

module.exports = compileForStatement;

export {};
