// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");

async function compileExpressionStatement(node, context) {
  await compileExpression(node.expression, context);
}

module.exports = compileExpressionStatement;

export {};
