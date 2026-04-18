// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, compileLiteralValue, emit, emitLabel, makeLabel, newRegister } = require("../utils");

async function compileLogicalExpression(node, context) {
  const leftRegister = await compileExpression(node.left, context);
  const resultRegister = newRegister(context);
  const endLabel = makeLabel(context);

  emit(context, [OpCode.MOVE, resultRegister, leftRegister]);
  if (node.operator === "&&") {
    emit(context, [OpCode.JUMPF, leftRegister, endLabel]);
  } else if (node.operator === "||") {
    emit(context, [OpCode.JUMPT, leftRegister, endLabel]);
  } else if (node.operator === "??") {
    const nullRegister = compileLiteralValue(null, context);
    const undefinedRegister = compileLiteralValue(undefined, context);
    const isNullRegister = newRegister(context);
    const isUndefinedRegister = newRegister(context);
    const useRightLabel = makeLabel(context, "NULLISH");
    emit(context, [OpCode.ISEQ, isNullRegister, leftRegister, nullRegister]);
    emit(context, [OpCode.ISEQ, isUndefinedRegister, leftRegister, undefinedRegister]);
    emit(context, [OpCode.JUMPT, isNullRegister, useRightLabel]);
    emit(context, [OpCode.JUMPT, isUndefinedRegister, useRightLabel]);
    emit(context, [OpCode.JUMP, endLabel]);
    emitLabel(context, useRightLabel);
  } else {
    throw new Error(`Unsupported logical operator: ${node.operator}`);
  }

  const rightRegister = await compileExpression(node.right, context);
  emit(context, [OpCode.MOVE, resultRegister, rightRegister]);
  emitLabel(context, endLabel);
  return resultRegister;
}

module.exports = compileLogicalExpression;

export {};
