// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileStatement } = require("../dispatch/statements");
const { withAnnexBBlockFunctionContext } = require("../annex-b");
const { OpCode, emit, emitLabel, makeLabel } = require("../utils");

async function compileIfStatement(node, context) {
  const testRegister = await compileExpression(node.test, context);
  const elseLabel = makeLabel(context);
  const endLabel = makeLabel(context);

  emit(context, [OpCode.JUMPF, testRegister, elseLabel]);
  await withAnnexBBlockFunctionContext(context, () => compileStatement(node.consequent, context));
  emit(context, [OpCode.JUMP, endLabel]);
  emitLabel(context, elseLabel);
  if (node.alternate) {
    await withAnnexBBlockFunctionContext(context, () => compileStatement(node.alternate, context));
  }
  emitLabel(context, endLabel);
}

module.exports = compileIfStatement;

export {};
