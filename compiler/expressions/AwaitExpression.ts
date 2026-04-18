// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, emit, newRegister } = require("../utils");

async function compileAwaitExpression(node, context) {
  const promiseRegister = await compileExpression(node.argument, context);
  const resultRegister = newRegister(context);
  emit(context, [OpCode.AWAIT, resultRegister, promiseRegister]);
  return resultRegister;
}

module.exports = compileAwaitExpression;

export {};
