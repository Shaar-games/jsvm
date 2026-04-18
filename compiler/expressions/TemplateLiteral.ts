// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { OpCode, compileLiteralValue, emit, newRegister } = require("../utils");

async function compileTemplateLiteral(node, context) {
  const resultRegister = newRegister(context);
  const emptyRegister = compileLiteralValue("", context);
  emit(context, [OpCode.MOVE, resultRegister, emptyRegister]);

  for (let index = 0; index < node.quasis.length; index += 1) {
    const quasi = node.quasis[index];
    const quasiRegister = compileLiteralValue(quasi.value.cooked ?? quasi.value.raw, context);
    emit(context, [OpCode.ADD, resultRegister, resultRegister, quasiRegister]);

    if (index < node.expressions.length) {
      const expressionRegister = await compileExpression(node.expressions[index], context);
      emit(context, [OpCode.ADD, resultRegister, resultRegister, expressionRegister]);
    }
  }

  return resultRegister;
}

module.exports = compileTemplateLiteral;

export {};
