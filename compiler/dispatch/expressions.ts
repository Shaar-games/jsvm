// @ts-nocheck
async function compileExpression(node, context) {
  const handler = context.expressionHandlers[node.type];
  if (!handler) {
    throw new Error(`Unsupported expression type: ${node.type}`);
  }
  return handler(node, context);
}

module.exports = {
  compileExpression,
};

export {};
