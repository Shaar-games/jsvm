// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");

async function compileChainExpression(node, context) {
  return compileExpression(node.expression, context);
}

module.exports = compileChainExpression;

export {};
