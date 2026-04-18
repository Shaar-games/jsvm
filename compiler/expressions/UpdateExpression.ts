// @ts-nocheck
const { OpCode, emit, compileLiteralValue, newRegister, loadBindingValue, storeBindingValue } = require("../utils");

async function compileUpdateExpression(node, context) {
  if (node.argument.type !== "Identifier") {
    throw new Error(`Unsupported update argument: ${node.argument.type}`);
  }

  const targetRegister = loadBindingValue(context, node.argument.name);
  const oneRegister = compileLiteralValue(1, context);
  const opcode = node.operator === "++" ? OpCode.ADD : OpCode.SUB;

  if (node.prefix) {
    emit(context, [opcode, targetRegister, targetRegister, oneRegister]);
    storeBindingValue(context, node.argument.name, targetRegister);
    return targetRegister;
  }

  const previousRegister = newRegister(context);
  emit(context, [OpCode.MOVE, previousRegister, targetRegister]);
  emit(context, [opcode, targetRegister, targetRegister, oneRegister]);
  storeBindingValue(context, node.argument.name, targetRegister);
  return previousRegister;
}

module.exports = compileUpdateExpression;

export {};
