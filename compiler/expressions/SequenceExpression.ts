// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");

async function compileSequenceExpression(node, context) {
  let resultRegister = null;
  for (const expression of node.expressions) {
    resultRegister = await compileExpression(expression, context);
  }
  return resultRegister;
}

module.exports = compileSequenceExpression;

export {};
