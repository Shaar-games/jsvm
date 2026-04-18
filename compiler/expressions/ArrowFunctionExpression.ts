// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { compileBlockStatement } = require("../statements/BlockStatement");
const { OpCode, compileFunctionLike, emit } = require("../utils");

async function compileArrowFunctionExpression(node, context) {
  return compileFunctionLike(node, context, `arrow_${context.labelCounter}`, async (functionContext) => {
    if (node.body.type === "BlockStatement") {
      await compileBlockStatement(node.body, functionContext, { isFunctionBody: true });
      return;
    }

    const resultRegister = await compileExpression(node.body, functionContext);
    emit(functionContext, [OpCode.RETURN, resultRegister]);
  });
}

module.exports = compileArrowFunctionExpression;

export {};
