// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, newRegister } = require("../utils");
const { getBinaryOpcodeName } = require("../operators");

async function compileBinaryExpression(node, context) {
  const leftRegister = await compileExpression(node.left, context);
  const rightRegister = await compileExpression(node.right, context);
  const resultRegister = newRegister(context);
  const opcodeName = getBinaryOpcodeName(node.operator);

  if (!opcodeName) {
    throw new Error(`Unsupported binary operator: ${node.operator}`);
  }

  emit(context, [OpCode[opcodeName], resultRegister, leftRegister, rightRegister]);
  return resultRegister;
}

module.exports = compileBinaryExpression;

export {};
