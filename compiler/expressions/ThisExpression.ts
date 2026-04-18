// @ts-nocheck
const { OpCode, emit, newRegister } = require("../utils");

async function compileThisExpression(_node, context) {
  const register = newRegister(context);
  emit(context, [OpCode.LOAD_THIS, register]);
  return register;
}

module.exports = compileThisExpression;

export {};
