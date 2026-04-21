// @ts-nocheck
const { compileAssignmentTarget, emitLoadAssignmentTarget, emitStoreAssignmentTarget } = require("../assignment-targets");
const { OpCode, emit, compileLiteralValue, newRegister, loadBindingValue, storeBindingValue } = require("../utils");
const {
  emitWebCompatCallAssignmentReferenceError,
  isWebCompatCallAssignmentTarget,
} = require("../web-compat-targets");

async function compileUpdateExpression(node, context) {
  if (isWebCompatCallAssignmentTarget(node.argument, context)) {
    await emitWebCompatCallAssignmentReferenceError(node.argument, context);
    return newRegister(context);
  }

  let targetRegister;
  let storeUpdatedValue;

  if (node.argument.type === "Identifier") {
    targetRegister = loadBindingValue(context, node.argument.name);
    storeUpdatedValue = (valueRegister) => storeBindingValue(context, node.argument.name, valueRegister);
  } else if (node.argument.type === "MemberExpression") {
    const target = await compileAssignmentTarget(node.argument, context);
    targetRegister = emitLoadAssignmentTarget(target, context);
    storeUpdatedValue = (valueRegister) => emitStoreAssignmentTarget(target, valueRegister, context);
  } else {
    throw new Error(`Unsupported update argument: ${node.argument.type}`);
  }

  const oneRegister = compileLiteralValue(1, context);
  const opcode = node.operator === "++" ? OpCode.ADD : OpCode.SUB;

  if (node.prefix) {
    emit(context, [opcode, targetRegister, targetRegister, oneRegister]);
    storeUpdatedValue(targetRegister);
    return targetRegister;
  }

  const previousRegister = newRegister(context);
  emit(context, [OpCode.MOVE, previousRegister, targetRegister]);
  emit(context, [opcode, targetRegister, targetRegister, oneRegister]);
  storeUpdatedValue(targetRegister);
  return previousRegister;
}

module.exports = compileUpdateExpression;

export {};
