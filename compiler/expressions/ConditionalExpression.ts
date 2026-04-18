// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, emitLabel, makeLabel, newRegister } = require("../utils");

async function compileConditionalExpression(node, context) {
  const testRegister = await compileExpression(node.test, context);
  const resultRegister = newRegister(context);
  const alternateLabel = makeLabel(context, "COND_ALT");
  const endLabel = makeLabel(context, "COND_END");

  emit(context, [OpCode.JUMPF, testRegister, alternateLabel]);
  const consequentRegister = await compileExpression(node.consequent, context);
  emit(context, [OpCode.MOVE, resultRegister, consequentRegister]);
  emit(context, [OpCode.JUMP, endLabel]);
  emitLabel(context, alternateLabel);
  const alternateRegister = await compileExpression(node.alternate, context);
  emit(context, [OpCode.MOVE, resultRegister, alternateRegister]);
  emitLabel(context, endLabel);
  return resultRegister;
}

module.exports = compileConditionalExpression;

export {};
