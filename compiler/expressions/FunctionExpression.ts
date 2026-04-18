// @ts-nocheck
const { compileBlockStatement } = require("../statements/BlockStatement");
const { compileFunctionLike } = require("../utils");

async function compileFunctionExpression(node, context) {
  const functionName = node.id ? node.id.name : `anonymous_${context.labelCounter}`;
  return compileFunctionLike(node, context, functionName, async (functionContext) => {
    await compileBlockStatement(node.body, functionContext, { isFunctionBody: true });
  });
}

module.exports = compileFunctionExpression;

export {};
